import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { join as posixJoin } from "node:path/posix";
import { v4 as uuid } from "uuid";
import { asc, db, eq, inArray } from "@loxaic/db";
import { checkpointFiles, conversations, messages, sandboxes, usageRecords, user } from "@loxaic/db/schema";
import { attachDirectory, getHostProvider } from "../../sandbox/host-provider.ts";
import type { SandboxHandle } from "../../sandbox/provider.ts";
import {
  CHECKPOINT_KEEP_TURNS,
  CHECKPOINT_MAX_FILE_BYTES,
  checkpointsSince,
  recordBeforeWrite,
  restoreCheckpoints,
} from "../checkpoints.ts";
import { executeTool } from "../executor.ts";
import { initStreamBroker } from "../../streams/index.ts";
import { getRunByConversation } from "../../streams/registry.ts";
import { retryAgentRun, startAgentRun } from "../../streams/runs/agentRun.ts";
import { __resetMockScenariosForTest } from "../../inference/mock-scenarios.ts";
import { destroyConversationSandboxes, getConversationSandbox } from "../sandbox-manager.ts";
import { previewRewind, rewindConversation } from "../../conversations/rewind.ts";
import { getContainerProvider } from "../../sandbox/container-provider.ts";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";

/**
 * File checkpoints (#166), on the host provider, which needs no container
 * engine and whose files can be read back directly. What a turn's
 * `fs_write`/`fs_edit` changed is put back by a rewind; a `bash` command's
 * changes are not; symlinks and files over 10 MiB are reported, not copied.
 */
process.env.MOCK_INFERENCE = "true";

const userId = `test-checkpoints-${uuid()}`;
const scratch = mkdtempSync(path.join(os.tmpdir(), "loxaic-checkpoints-"));
const hostRoot = path.join(scratch, "sandboxes");
const convIds: string[] = [];
let lamport = Date.now();

beforeAll(async () => {
  mkdirSync(hostRoot, { recursive: true });
  process.env.SANDBOX_HOST_ROOT = hostRoot;
  process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
  await initStreamBroker();
  await db.insert(user).values({
    id: userId, name: "Checkpoints", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

afterAll(async () => {
  for (const id of convIds) await destroyConversationSandboxes(id).catch(() => undefined);
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  if (convIds.length) {
    await db.delete(checkpointFiles).where(inArray(checkpointFiles.conversationId, convIds));
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  delete process.env.SANDBOX_HOST_ROOT;
  delete process.env.SANDBOX_MODE;
  delete process.env.MOCK_SCENARIOS_FILE;
  delete process.env.DELETED_CHAT_RETENTION_ENABLED;
  __resetMockScenariosForTest();
  rmSync(scratch, { recursive: true, force: true });
});

async function newConv(kind: "chat" | "agent" = "agent"): Promise<string> {
  const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "checkpoints", kind }).returning();
  convIds.push(conv.id);
  return conv.id;
}

/** A user row for a turn, so its checkpoints have a message to be keyed to
 * and a time to be compared against. */
async function turnRow(convId: string): Promise<{ id: string; createdAt: Date }> {
  const id = uuid();
  const createdAt = new Date();
  await db.insert(messages).values({
    id, conversationId: convId, authorType: "user", authorUserId: userId, origin: "server",
    lamport: lamport++, content: [{ kind: "text", text: "a turn" }], status: "complete", createdAt,
  });
  await new Promise((r) => setTimeout(r, 3));
  return { id, createdAt };
}

/** What `fs_write` does in a turn, checkpoint included. */
async function agentWrite(handle: SandboxHandle, convId: string, turnId: string, file: string, content: string) {
  const res = await executeTool(handle, "fs_write", { path: file, content }, undefined, (p) =>
    recordBeforeWrite(handle, { conversationId: convId, turnMessageId: turnId }, p),
  );
  expect(res.ok).toBe(true);
}

describe("file checkpoints in a server workspace", () => {
  let handle: SandboxHandle;
  const at = (rel: string) => path.join(handle.workdir, rel);

  beforeAll(async () => {
    handle = await getHostProvider().create(userId, {});
  });

  afterAll(async () => {
    await handle.destroy();
  });

  it("puts an edited file back, deletes one the turn created, and leaves a bash change alone", async () => {
    const convId = await newConv();
    writeFileSync(at("kept.txt"), "original\n");
    const turn = await turnRow(convId);
    await agentWrite(handle, convId, turn.id, "kept.txt", "changed by the agent\n");
    await agentWrite(handle, convId, turn.id, "new.txt", "made by the agent\n");
    // A second write in the same turn does not replace the first record.
    await agentWrite(handle, convId, turn.id, "kept.txt", "changed again\n");
    await handle.exec(["bash", "-c", "echo by bash > shell.txt"], { workdir: handle.workdir });

    const records = await checkpointsSince(convId, turn.createdAt);
    expect(records.map((r) => [r.path, r.state])).toEqual([
      [at("kept.txt"), "saved"],
      [at("new.txt"), "missing"],
    ]);
    // The copy lives beside the working tree, never in it.
    expect(existsSync(path.join(handle.root, ".loxaic", "checkpoints", convId, turn.id, records[0].id))).toBe(true);

    const report = await restoreCheckpoints(handle, convId, records);
    expect(report.restored.sort()).toEqual([at("kept.txt"), at("new.txt")].sort());
    expect(report.skipped).toEqual([]);
    expect(readFileSync(at("kept.txt"), "utf8")).toBe("original\n");
    expect(existsSync(at("new.txt"))).toBe(false);
    expect(readFileSync(at("shell.txt"), "utf8")).toBe("by bash\n");
  });

  it("restores to the state before the oldest turn asked for", async () => {
    const convId = await newConv();
    writeFileSync(at("multi.txt"), "v0");
    const first = await turnRow(convId);
    await agentWrite(handle, convId, first.id, "multi.txt", "v1");
    const second = await turnRow(convId);
    await agentWrite(handle, convId, second.id, "multi.txt", "v2");

    await restoreCheckpoints(handle, convId, await checkpointsSince(convId, second.createdAt));
    expect(readFileSync(at("multi.txt"), "utf8")).toBe("v1");
    await agentWrite(handle, convId, second.id, "multi.txt", "v2 again");
    await restoreCheckpoints(handle, convId, await checkpointsSince(convId, first.createdAt));
    expect(readFileSync(at("multi.txt"), "utf8")).toBe("v0");
  });

  it("reports a symlink and a file over 10 MiB instead of copying them", async () => {
    const convId = await newConv();
    writeFileSync(path.join(scratch, "outside.txt"), "outside");
    symlinkSync(path.join(scratch, "outside.txt"), at("link.txt"));
    writeFileSync(at("big.bin"), Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1));
    const turn = await turnRow(convId);
    await recordBeforeWrite(handle, { conversationId: convId, turnMessageId: turn.id }, at("link.txt"));
    await recordBeforeWrite(handle, { conversationId: convId, turnMessageId: turn.id }, at("big.bin"));

    const report = await restoreCheckpoints(handle, convId, await checkpointsSince(convId, turn.createdAt));
    expect(report.restored).toEqual([]);
    expect(report.skipped.map((s) => s.path).sort()).toEqual([at("big.bin"), at("link.txt")].sort());
    // A restore never writes through a link out of the workspace.
    expect(readFileSync(path.join(scratch, "outside.txt"), "utf8")).toBe("outside");
  });

  it(`keeps the newest ${String(CHECKPOINT_KEEP_TURNS)} turns' checkpoints`, async () => {
    const convId = await newConv();
    const turns: string[] = [];
    for (let i = 0; i <= CHECKPOINT_KEEP_TURNS; i++) {
      const turn = uuid();
      turns.push(turn);
      await recordBeforeWrite(handle, { conversationId: convId, turnMessageId: turn }, at(`t${String(i)}.txt`));
    }
    const kept = await db
      .selectDistinct({ turn: checkpointFiles.turnMessageId })
      .from(checkpointFiles)
      .where(eq(checkpointFiles.conversationId, convId));
    expect(kept).toHaveLength(CHECKPOINT_KEEP_TURNS);
    expect(kept.map((k) => k.turn)).not.toContain(turns[0]);
    expect(existsSync(path.join(handle.root, ".loxaic", "checkpoints", convId, turns[0]))).toBe(false);
  });
});

// Asked before any case switches this file to host mode.
const dockerReady = await sandboxImageReady();

describe("file checkpoints in a container", () => {
  it.skipIf(!dockerReady)("keeps the copies beside the working tree, and puts a binary file back byte for byte", async () => {
    const handle = await getContainerProvider().create(userId, {});
    try {
      const convId = await newConv();
      const file = posixJoin(handle.workdir, "data.bin");
      // Bytes `readFile` could never carry: a NUL and an invalid UTF-8 byte.
      await handle.exec(["bash", "-c", "printf 'a\\000b\\377c' > data.bin && chmod 640 data.bin"], { workdir: handle.workdir });
      const before = (await handle.exec(["bash", "-c", "od -An -tx1 data.bin; stat -c %a data.bin"], { workdir: handle.workdir })).stdout;
      const turn = await turnRow(convId);
      await recordBeforeWrite(handle, { conversationId: convId, turnMessageId: turn.id }, file);
      await handle.writeFile(file, "overwritten by the agent\n");

      const [record] = await checkpointsSince(convId, turn.createdAt);
      const listed = await handle.exec(["bash", "-c", `ls /home/loxaic/.loxaic/checkpoints/${convId}/${turn.id}`], { workdir: handle.workdir });
      expect(listed.stdout.trim()).toBe(record.id);

      const report = await restoreCheckpoints(handle, convId, [record]);
      expect(report).toEqual({ restored: [file], skipped: [] });
      const after = (await handle.exec(["bash", "-c", "od -An -tx1 data.bin; stat -c %a data.bin"], { workdir: handle.workdir })).stdout;
      expect(after).toBe(before);
      expect(before).toContain("640");
    } finally {
      await handle.destroy();
    }
  });
});

describe("file checkpoints in a folder on the person's own machine", () => {
  it("keeps the copies in their home directory, never in the folder", async () => {
    const folder = mkdtempSync(path.join(scratch, "project-"));
    const home = mkdtempSync(path.join(scratch, "home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const handle = attachDirectory(folder);
      const convId = await newConv();
      writeFileSync(path.join(folder, "notes.md"), "mine\n");
      const turn = await turnRow(convId);
      await agentWrite(handle, convId, turn.id, "notes.md", "the agent's\n");

      expect(existsSync(path.join(folder, ".loxaic"))).toBe(false);
      expect(existsSync(path.join(home, ".loxaic", "checkpoints", convId, turn.id))).toBe(true);
      await restoreCheckpoints(handle, convId, await checkpointsSince(convId, turn.createdAt));
      expect(readFileSync(path.join(folder, "notes.md"), "utf8")).toBe("mine\n");
    } finally {
      process.env.HOME = savedHome;
    }
  });
});

describe("a rewind with the agent's real edits", () => {
  beforeAll(() => {
    const file = path.join(scratch, "scenarios.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "edit the project",
          steps: [
            { tool: "fs_write", args: { path: "app.js", content: "const answer = 41;\n" } },
            { tool: "fs_edit", args: { path: "app.js", oldText: "41", newText: "42" } },
            { tool: "bash", args: { command: "echo built > build.log" } },
          ],
          finalText: "[Mock] edited.\n",
        },
        {
          // Anchored: the parent's prompt carries this text after its colon,
          // and only the child's starts with it.
          match: "^child edits",
          steps: [{ tool: "fs_write", args: { path: "child.txt", content: "by the child\n" } }],
          finalText: "[Mock] child done.\n",
        },
      ]),
    );
    process.env.SANDBOX_MODE = "host";
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  });

  async function editTurn(): Promise<{ convId: string; userMessageId: string; workdir: string }> {
    const started = await startAgentRun({ userId, content: "please edit the project", model: "llama-3.1-8b-instruct", mode: "auto" });
    convIds.push(started.conversationId);
    const deadline = Date.now() + 20_000;
    while (getRunByConversation(started.conversationId)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run");
      await new Promise((r) => setTimeout(r, 25));
    }
    const handle = await getConversationSandbox(userId, started.conversationId);
    expect(readFileSync(path.join(handle.workdir, "app.js"), "utf8")).toBe("const answer = 42;\n");
    return { convId: started.conversationId, userMessageId: started.userMessageId, workdir: handle.workdir };
  }

  const rows = (convId: string) =>
    db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.lamport));

  it("conversation and files: the edits are undone, the bash output stays, and the turn's checkpoints go", async () => {
    const { convId, userMessageId, workdir } = await editTurn();
    expect(await previewRewind({ userId, conversationId: convId, messageId: userMessageId })).toMatchObject({ files: 1 });

    const result = await rewindConversation({ userId, conversationId: convId, messageId: userMessageId, scope: "both" });

    expect(result.files).toEqual({ restored: [path.join(workdir, "app.js")], skipped: [] });
    expect(existsSync(path.join(workdir, "app.js"))).toBe(false);
    expect(readFileSync(path.join(workdir, "build.log"), "utf8")).toBe("built\n");
    expect(await rows(convId)).toEqual([]);
    expect(await db.select().from(checkpointFiles).where(eq(checkpointFiles.conversationId, convId))).toEqual([]);
  });

  it("conversation only: the files keep the agent's edits", async () => {
    const { convId, userMessageId, workdir } = await editTurn();
    const result = await rewindConversation({ userId, conversationId: convId, messageId: userMessageId, scope: "conversation" });
    expect(result.files).toBeNull();
    expect(readFileSync(path.join(workdir, "app.js"), "utf8")).toBe("const answer = 42;\n");
    expect(await rows(convId)).toEqual([]);
  });

  it("files only: the conversation and its checkpoints stay, so it can be done again", async () => {
    const { convId, userMessageId, workdir } = await editTurn();
    const before = (await rows(convId)).length;
    const result = await rewindConversation({ userId, conversationId: convId, messageId: userMessageId, scope: "files" });
    expect(result.removedIds).toEqual([]);
    expect(result.files?.restored).toEqual([path.join(workdir, "app.js")]);
    expect(existsSync(path.join(workdir, "app.js"))).toBe(false);
    expect(await rows(convId)).toHaveLength(before);
    expect(await previewRewind({ userId, conversationId: convId, messageId: userMessageId })).toMatchObject({ files: 1 });
  });

  it("a sub-agent's edits are its parent's turn's, and go with it", async () => {
    const started = await startAgentRun({
      userId, content: "Use a sub-agent: child edits the project", model: "llama-3.1-8b-instruct", mode: "auto",
    });
    const convId = started.conversationId;
    convIds.push(convId);
    const deadline = Date.now() + 20_000;
    while (getRunByConversation(convId)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run");
      await new Promise((r) => setTimeout(r, 25));
    }
    const records = await db.select().from(checkpointFiles).where(eq(checkpointFiles.conversationId, convId));
    expect(records.map((r) => [path.basename(r.path), r.turnMessageId])).toEqual([["child.txt", started.userMessageId]]);
    const { workdir } = await getConversationSandbox(userId, convId);
    expect(readFileSync(path.join(workdir, "child.txt"), "utf8")).toBe("by the child\n");

    await rewindConversation({ userId, conversationId: convId, messageId: started.userMessageId, scope: "both" });
    expect(existsSync(path.join(workdir, "child.txt"))).toBe(false);
  });

  it("a retry that asks for it puts the turn's edits back before answering again", async () => {
    const { convId, userMessageId, workdir } = await editTurn();
    writeFileSync(path.join(workdir, "app.js"), "edited by hand after the turn\n");
    const retried = await retryAgentRun({
      userId, conversationId: convId, model: "llama-3.1-8b-instruct", mode: "auto", restoreFiles: true,
    });
    expect(retried.userMessageId).toBe(userMessageId);
    // Put back to before the turn — the file did not exist — then made again
    // by the new run.
    expect(retried.restoredFiles).toEqual({ restored: [path.join(workdir, "app.js")], skipped: [] });
    const deadline = Date.now() + 20_000;
    while (getRunByConversation(convId)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(readFileSync(path.join(workdir, "app.js"), "utf8")).toBe("const answer = 42;\n");
    // The turn's checkpoint still records the state before it.
    const records = await db.select().from(checkpointFiles).where(eq(checkpointFiles.conversationId, convId));
    expect(records.map((r) => [path.basename(r.path), r.state])).toEqual([["app.js", "missing"]]);
  });
});
