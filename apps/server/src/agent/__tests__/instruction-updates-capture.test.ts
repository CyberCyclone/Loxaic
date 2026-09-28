import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, sandboxes, user } from "@loxaic/db/schema";
import type { ContentBlock, ProjectInstructions, StreamEventKind, Workspace } from "@loxaic/types";
import { __resetExecutorsForTest, handleExecutorResult, registerExecutor } from "../../executor/registry.ts";
import { createExecutorService } from "../../executor/service.ts";
import type { ServerToExecutor } from "../../executor/protocol.ts";
import { historyFront } from "../../streams/runs/engine.ts";
import { prepareInstructions } from "../instruction-updates.ts";

/**
 * The per-run check, end to end over a real database: a change becomes one
 * notice on that run's user message, and the newest version reaches the
 * system prompt only when the front of the prompt moves anyway.
 */
const userId = `test-instr-updates-${uuid()}`;
const EXECUTOR = "laptop-updates";
let root: string;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId, name: "Updates", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-updates-")));
  const service = createExecutorService({ roots: () => [root], executorId: EXECUTOR });
  registerExecutor({
    executorId: EXECUTOR, userId, name: "Laptop", platform: process.platform,
    capabilities: { direct: true, container: false }, roots: [root],
    send(message: ServerToExecutor) {
      if (message.type !== "call") return;
      void service.handle(message.method, message.params)
        .then((value) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: true, value }); })
        .catch((err: unknown) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: false, error: (err as Error).message }); });
    },
    close: () => undefined,
  });
});

afterEach(async () => {
  __resetExecutorsForTest();
  const convs = await db.query.conversations.findMany({ where: eq(conversations.ownerId, userId), columns: { id: true } });
  for (const c of convs) await db.delete(messages).where(eq(messages.conversationId, c.id));
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

const RULES = [
  "# Rules",
  "## Commands",
  "Use pnpm.",
  "## Style",
  "Two spaces.",
  "## Stable",
  "Unchanged guidance. ".repeat(30),
].join("\n");

const local = (): Workspace => ({ kind: "local", executorId: EXECUTOR, executorName: "Laptop", path: root, isolation: "direct" });

async function conversation(workspace: Workspace): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: userId, kind: "agent", workspace }).returning();
  return row.id;
}

let lamport = Date.now();
async function userMessage(convId: string, text = "hello"): Promise<string> {
  const id = uuid();
  await db.insert(messages).values({
    id, conversationId: convId, authorType: "user", authorUserId: userId, origin: "server",
    lamport: ++lamport, content: [{ kind: "text", text }], status: "complete", createdAt: new Date(),
  });
  return id;
}

/** One run's preparation, as the tool loop would call it; returns what it emitted. */
async function run(convId: string, workspace: Workspace): Promise<{ msgId: string; events: StreamEventKind[] }> {
  const msgId = await userMessage(convId);
  const events: StreamEventKind[] = [];
  await prepareInstructions({ convId, ownerId: userId, workspace, userMsgId: msgId, producer: { emit: (e) => { events.push(e); } } });
  return { msgId, events };
}

async function snapshot(convId: string): Promise<ProjectInstructions> {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, convId), columns: { instructions: true } });
  return row?.instructions as ProjectInstructions;
}

async function blocksOf(msgId: string): Promise<ContentBlock[]> {
  const row = await db.query.messages.findFirst({ where: eq(messages.id, msgId), columns: { content: true } });
  return (row?.content ?? []) as ContentBlock[];
}

const notices = (blocks: ContentBlock[]) =>
  blocks.filter((b): b is Extract<ContentBlock, { kind: "instructions_update" }> => b.kind === "instructions_update");

describe("a local folder", () => {
  it("takes the snapshot, then says nothing while the file is unchanged", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());
    const first = await snapshot(id);
    expect(first).toMatchObject({ status: "found", path: "AGENTS.md" });
    expect(first.status === "found" && first.cksums?.["AGENTS.md"]).toMatch(/^\d+ \d+$/);
    expect(first.status !== "unavailable" && first.frontKey).toBeTruthy();

    const { msgId, events } = await run(id, local());
    expect(notices(await blocksOf(msgId))).toEqual([]);
    expect(events).toEqual([]);
    expect(await snapshot(id)).toEqual(first);
  });

  it("puts an edit on that run's message, once, and leaves the system-prompt version alone", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());

    writeFileSync(path.join(root, "AGENTS.md"), RULES.replace("Use pnpm.", "Use pnpm, never npm."));
    const edited = await run(id, local());
    const [notice] = notices(await blocksOf(edited.msgId));
    expect(notice).toMatchObject({ kind: "instructions_update", path: "AGENTS.md", summary: "AGENTS.md: 1 section changed" });
    expect(notice.text).toContain("## Commands\nUse pnpm, never npm.");
    expect(edited.events).toEqual([
      { kind: "instructions.update", message_id: edited.msgId, path: "AGENTS.md", summary: "AGENTS.md: 1 section changed" },
    ]);
    const snap = await snapshot(id);
    // The system prompt's version is untouched; the chat's is the new one.
    expect(snap.status === "found" && snap.text).toBe(RULES);
    expect(snap.status === "found" && snap.latest?.text).toContain("never npm");

    const after = await run(id, local());
    expect(notices(await blocksOf(after.msgId))).toEqual([]);
  });

  it("folds the newest version into the system prompt when a compaction lands, and says nothing then", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());
    writeFileSync(path.join(root, "AGENTS.md"), RULES.replace("Two spaces.", "Tabs."));
    await run(id, local());

    await db.insert(messages).values({
      id: uuid(), conversationId: id, authorType: "summary", origin: "server", lamport: ++lamport,
      content: [{ kind: "text", text: "Summary of the conversation so far." }], status: "complete", createdAt: new Date(),
    });
    const folded = await run(id, local());
    expect(notices(await blocksOf(folded.msgId))).toEqual([]);
    const snap = await snapshot(id);
    expect(snap).toMatchObject({ status: "found", text: RULES.replace("Two spaces.", "Tabs.") });
    expect(snap.status === "found" && (snap.latest ?? snap.decision)).toBeUndefined();
  });

  it("folds when the history window moves, and not on an ordinary turn", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());
    writeFileSync(path.join(root, "AGENTS.md"), RULES.replace("Two spaces.", "Tabs."));
    await run(id, local());
    // An ordinary turn: the front has not moved, so no fold.
    await run(id, local());
    expect((await snapshot(id)).status === "found" && (await snapshot(id) as { latest?: unknown }).latest).toBeTruthy();

    const frontBefore = await historyFront(id);
    for (let i = 0; i < 80; i++) await userMessage(id, `filler ${String(i)}`);
    expect(await historyFront(id)).not.toBe(frontBefore);
    await run(id, local());
    expect(await snapshot(id)).toMatchObject({ status: "found", text: RULES.replace("Two spaces.", "Tabs.") });
  });

  it("says when the file is removed, and when one appears", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());
    rmSync(path.join(root, "AGENTS.md"));
    const removed = await run(id, local());
    expect(notices(await blocksOf(removed.msgId))).toMatchObject([{ summary: "AGENTS.md was removed" }]);

    const bare = await conversation(local());
    await run(bare, local());
    expect(await snapshot(bare)).toMatchObject({ status: "none" });
    writeFileSync(path.join(root, "CLAUDE.md"), "# New\nrules\n");
    const created = await run(bare, local());
    expect(notices(await blocksOf(created.msgId))).toMatchObject([{ summary: "The project now has CLAUDE.md" }]);
  });

  it("goes ahead without a check while the machine is offline", async () => {
    writeFileSync(path.join(root, "AGENTS.md"), RULES);
    const id = await conversation(local());
    await run(id, local());
    const before = await snapshot(id);
    __resetExecutorsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { msgId } = await run(id, local());
      expect(notices(await blocksOf(msgId))).toEqual([]);
      expect((await snapshot(id)).status === "found" && (await snapshot(id) as { text: string }).text).toBe(
        before.status === "found" ? before.text : "",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a GitHub checkout", () => {
  const github: Workspace = {
    kind: "github", repo: "octo/real", baseBranch: "main", branch: "loxaic/x", cloneUrl: "https://github.example/octo/real.git",
  };
  let hostRoot: string;

  beforeEach(() => {
    hostRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-host-")));
    process.env.SANDBOX_MODE = "host";
    process.env.SANDBOX_HOST_ROOT = hostRoot;
  });

  afterEach(async () => {
    const { destroyConversationSandboxes } = await import("../sandbox-manager.ts");
    const convs = await db.query.conversations.findMany({ where: eq(conversations.ownerId, userId), columns: { id: true } });
    for (const c of convs) await destroyConversationSandboxes(c.id).catch(() => undefined);
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
    delete process.env.SANDBOX_MODE;
    delete process.env.SANDBOX_HOST_ROOT;
    rmSync(hostRoot, { recursive: true, force: true });
  });

  /** A conversation whose snapshot came from GitHub's API, with a host
   * sandbox row standing in for its clone. */
  async function seeded(): Promise<{ id: string; repo: string }> {
    const id = await conversation(github);
    await db
      .update(conversations)
      .set({
        instructions: {
          status: "found", path: "AGENTS.md", text: RULES, sourceBytes: RULES.length, sourceTruncated: false,
          fetchedAt: "2026-09-28T00:00:00.000Z",
        },
      })
      .where(eq(conversations.id, id));
    const dir = path.join(hostRoot, uuid());
    mkdirSync(path.join(dir, "repo"), { recursive: true });
    writeFileSync(path.join(dir, "repo", "AGENTS.md"), RULES);
    await db.insert(sandboxes).values({
      ownerId: userId, conversationId: id, containerId: dir, provider: "host", image: "host", status: "stopped",
      limits: { memory: 512, cpu: 1 }, createdAt: new Date(),
    });
    return { id, repo: path.join(dir, "repo") };
  }

  it("does not wake a paused sandbox to check", async () => {
    const { id, repo } = await seeded();
    writeFileSync(path.join(repo, "AGENTS.md"), RULES.replace("Use pnpm.", "Use bun."));
    const { msgId } = await run(id, github);
    expect(notices(await blocksOf(msgId))).toEqual([]);
    const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.conversationId, id), columns: { status: true } });
    expect(row?.status).toBe("stopped");
  });

  it("checks the checkout while its sandbox is live: same words from the API only store checksums", async () => {
    const { id, repo } = await seeded();
    const { getConversationSandbox } = await import("../sandbox-manager.ts");
    await getConversationSandbox(userId, id);

    const same = await run(id, github);
    expect(notices(await blocksOf(same.msgId))).toEqual([]);
    const stored = await snapshot(id);
    expect(stored.status === "found" && stored.cksums?.["AGENTS.md"]).toMatch(/^\d+ \d+$/);

    // A pull, a branch switch or an edit in the checkout: the model is told.
    writeFileSync(path.join(repo, "AGENTS.md"), RULES.replace("Use pnpm.", "Use bun."));
    const changed = await run(id, github);
    expect(notices(await blocksOf(changed.msgId))).toMatchObject([{ summary: "AGENTS.md: 1 section changed" }]);
  });
});

describe("the front of the prompt", () => {
  it("moves on a compaction and on the window's anchor, and not on an ordinary message", async () => {
    const id = await conversation(local());
    const a = await historyFront(id);
    await userMessage(id);
    expect(await historyFront(id)).toBe(a);
    for (let i = 0; i < 80; i++) await userMessage(id);
    const b = await historyFront(id);
    expect(b).not.toBe(a);
    await db.insert(messages).values({
      id: uuid(), conversationId: id, authorType: "summary", origin: "server", lamport: ++lamport,
      content: [{ kind: "text", text: "S" }], status: "complete", createdAt: new Date(),
    });
    expect(await historyFront(id)).not.toBe(b);
  });
});
