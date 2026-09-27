import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, githubConnections, user } from "@loxaic/db/schema";
import type { ProjectInstructions, Workspace } from "@loxaic/types";
import { upsertConnection } from "../../github/connection.ts";
import {
  __resetExecutorsForTest,
  handleExecutorResult,
  registerExecutor,
} from "../../executor/registry.ts";
import { createExecutorService } from "../../executor/service.ts";
import type { ServerToExecutor } from "../../executor/protocol.ts";
import { ensureInstructions, MAX_INSTRUCTIONS_SOURCE_BYTES } from "../instructions.ts";
import { agentSystemPrompt } from "../../streams/runs/agentRun.ts";

process.env.MCP_ENCRYPTION_KEY ??= "instructions-test-key";

/**
 * Taking the snapshot: once, before the first request, from wherever the
 * workspace's files really are — GitHub for a github workspace, the user's
 * own machine for a local one — and never again once it has succeeded.
 */
const userId = `test-instructions-${uuid()}`;
const TOKEN = `ghp_${"z9y8x7w6v5".repeat(3)}qrstu`;
let mock: Server;
let hits: string[] = [];
/** repo → file → body, or a status to answer with. */
let files: Partial<Record<string, Record<string, string | number>>> = {};

beforeAll(async () => {
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${url.pathname}${url.search}`);
    const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    const entry = m ? files[m[1]]?.[decodeURIComponent(m[2])] : undefined;
    if (typeof entry === "number") {
      res.statusCode = entry;
      res.end(JSON.stringify({ message: `failed; token was ${req.headers.authorization ?? ""}` }));
    } else if (typeof entry === "string" && url.searchParams.get("ref") === "trunk" && req.headers.accept === "application/vnd.github.raw") {
      res.end(entry);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise<void>((r) => { mock.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((mock.address() as { port: number }).port)}`;
  await db.insert(user).values({
    id: userId, name: "Instructions", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

beforeEach(async () => {
  hits = [];
  files = {};
  await upsertConnection(userId, { token: TOKEN, login: "octo", name: null, email: null, scopes: "repo" });
});

afterEach(async () => {
  __resetExecutorsForTest();
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await new Promise((r) => { mock.close(r); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
});

const github: Workspace = {
  kind: "github", repo: "octo/real", baseBranch: "trunk", branch: "loxaic/abc", cloneUrl: "https://github.example/octo/real.git",
};

async function conversation(workspace: Workspace | null): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: userId, kind: "agent", workspace }).returning();
  return row.id;
}

async function stored(id: string): Promise<ProjectInstructions | null> {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id), columns: { instructions: true } });
  return (row?.instructions ?? null) as ProjectInstructions | null;
}

describe("a github workspace", () => {
  it("reads AGENTS.md at the base branch, stores it, and never asks again", async () => {
    files["octo/real"] = { "AGENTS.md": "# Rules\nUse pnpm.\n" };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap).toMatchObject({ status: "found", path: "AGENTS.md", text: "# Rules\nUse pnpm.\n", sourceTruncated: false });
    expect(await stored(id)).toMatchObject({ status: "found", path: "AGENTS.md" });
    const asked = hits.length;
    await ensureInstructions(id, userId, github);
    expect(hits.length).toBe(asked);
  });

  it("falls back to CLAUDE.md only when there is no AGENTS.md", async () => {
    files["octo/real"] = { "CLAUDE.md": "claude rules" };
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "found", path: "CLAUDE.md" });
  });

  it("takes Codex's override first, then AGENTS.md, CLAUDE.md, GEMINI.md, and Copilot's file last", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "AGENTS.override.md": "o", "AGENTS.md": "a", "CLAUDE.md": "c" }, "AGENTS.override.md"],
      [{ "AGENTS.md": "a", "CLAUDE.md": "c", "GEMINI.md": "g" }, "AGENTS.md"],
      [{ "CLAUDE.md": "c", "GEMINI.md": "g" }, "CLAUDE.md"],
      [{ "GEMINI.md": "g", ".github/copilot-instructions.md": "p" }, "GEMINI.md"],
      [{ ".github/copilot-instructions.md": "copilot rules" }, ".github/copilot-instructions.md"],
    ];
    for (const [present, expected] of cases) {
      files["octo/real"] = present;
      const id = await conversation(github);
      const snap = await ensureInstructions(id, userId, github);
      expect({ present: Object.keys(present), path: snap?.status === "found" ? snap.path : null }).toEqual({
        present: Object.keys(present),
        path: expected,
      });
    }
  });

  it("records that there is none, so it is not looked for again", async () => {
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "none" });
    const asked = hits.length;
    await ensureInstructions(id, userId, github);
    expect(hits.length).toBe(asked);
  });

  it("reads a huge file only up to the cap and says so", async () => {
    files["octo/real"] = { "AGENTS.md": "a".repeat(MAX_INSTRUCTIONS_SOURCE_BYTES + 5000) };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap).toMatchObject({ status: "found", sourceTruncated: true, sourceBytes: MAX_INSTRUCTIONS_SOURCE_BYTES });
  });

  it("writes nothing when GitHub fails, tries again next time, and never logs the token", async () => {
    files["octo/real"] = { "AGENTS.md": 500 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const id = await conversation(github);
      expect(await ensureInstructions(id, userId, github)).toBeNull();
      expect(await stored(id)).toBeNull();
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
      files["octo/real"] = { "AGENTS.md": "now it works" };
      expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "found", text: "now it works" });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not look without a GitHub connection, and does not record none", async () => {
    await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toBeNull();
    expect(await stored(id)).toBeNull();
    expect(hits).toEqual([]);
  });
});

describe("other workspaces", () => {
  it("has nothing to read in scratch", async () => {
    const id = await conversation(null);
    expect(await ensureInstructions(id, userId, { kind: "scratch" })).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  describe("a local folder", () => {
    let root: string;
    beforeEach(() => { root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-local-"))); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    /** The desktop's executor, in process, over a real directory — only the
     * socket elided (the executor-provider.test.ts pattern). */
    function connectMachine(roots: string[]): void {
      const service = createExecutorService({ roots: () => roots, executorId: "laptop-instr" });
      registerExecutor({
        executorId: "laptop-instr", userId, name: "Laptop", platform: process.platform,
        capabilities: { direct: true, container: false }, roots,
        send(message: ServerToExecutor) {
          if (message.type !== "call") return;
          void service.handle(message.method, message.params)
            .then((value) => { handleExecutorResult("laptop-instr", { type: "result", id: message.id, ok: true, value }); })
            .catch((err: unknown) => { handleExecutorResult("laptop-instr", { type: "result", id: message.id, ok: false, error: (err as Error).message }); });
        },
        close: () => undefined,
      });
    }

    const local = (): Workspace => ({ kind: "local", executorId: "laptop-instr", executorName: "Laptop", path: root, isolation: "direct" });

    it("reads the folder's AGENTS.md on the user's machine, with no sandbox created", async () => {
      writeFileSync(path.join(root, "AGENTS.md"), "local rules ü\n");
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "AGENTS.md", text: "local rules ü\n" });
    });

    it("uses the same order on the user's machine, Copilot's file included", async () => {
      mkdirSync(path.join(root, ".github"));
      writeFileSync(path.join(root, ".github/copilot-instructions.md"), "copilot rules\n");
      writeFileSync(path.join(root, "GEMINI.md"), "gemini rules\n");
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "GEMINI.md" });
      rmSync(path.join(root, "GEMINI.md"));
      const id2 = await conversation(local());
      expect(await ensureInstructions(id2, userId, local())).toMatchObject({ status: "found", path: ".github/copilot-instructions.md" });
    });

    it("records none for a folder without one", async () => {
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "none" });
    });

    it("writes nothing while the machine is offline", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const id = await conversation(local());
        expect(await ensureInstructions(id, userId, local())).toBeNull();
        expect(await stored(id)).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it("is refused for a folder the machine no longer approves", async () => {
      writeFileSync(path.join(root, "AGENTS.md"), "secret");
      connectMachine([]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const id = await conversation(local());
        expect(await ensureInstructions(id, userId, local())).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("the system prompt built from it", () => {
  it("is identical on every run of the conversation and records its decision once", async () => {
    files["octo/real"] = { "AGENTS.md": "# Rules\nUse pnpm.\n" };
    const id = await conversation(github);
    const input = { convId: id, ownerId: userId, workspace: github, mode: "manual" as const, model: "llama-3.1-8b-instruct" };
    const first = await agentSystemPrompt(input);
    expect(first).toContain('<project-instructions path="AGENTS.md" mode="full">');
    expect(first).toContain("Use pnpm.");
    const decided = await stored(id);
    expect(decided).toMatchObject({ decision: { model: "llama-3.1-8b-instruct", mode: "full" } });
    expect(await agentSystemPrompt(input)).toBe(first);
    expect(await stored(id)).toEqual(decided);
  });

  it("is the base prompt alone when there is nothing to add", async () => {
    const id = await conversation(github);
    const prompt = await agentSystemPrompt({ convId: id, ownerId: userId, workspace: github, mode: "planning", model: "m" });
    expect(prompt).not.toContain("project-instructions");
    expect(prompt).toContain("PLANNING mode");
  });
});
