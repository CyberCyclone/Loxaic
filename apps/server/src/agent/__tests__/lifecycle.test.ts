import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, user } from "@loxaic/db/schema";
import {
  attachRunningSandbox,
  destroyConversationSandboxes,
  getConversationSandbox,
  reapAbandonedSandboxes,
  stopIdleSandboxes,
} from "../sandbox-manager.ts";
import { resetServerSettingsCache } from "../../settings.ts";

/**
 * Every reaper call here passes `kind: "host"`, and nothing asserts on a
 * reaper's **return count**. Both reapers walk every sandbox in the process,
 * so an unscoped call with the deliberately tiny windows below would pause or
 * destroy the container another suite is mid-run in — observed, as a 409 from
 * a container this file had quietly stopped.
 *
 * `reapAbandonedSandboxes()` is global by design — it is the server's janitor
 * — but suites share one Postgres, and these cases deliberately set a
 * one-millisecond retention window, which without the filter would destroy the
 * container another suite is mid-run in. Same precaution stop-all-sandboxes
 * .test.ts takes for the same reason — and, like that file, the counts these
 * global sweeps return include rows other suites own, so every case asserts on
 * the row it created instead.
 *
 * The sandbox lifecycle, end to end: paused rather than destroyed when idle,
 * resumed with its contents when touched again, and destroyed only by the two
 * things allowed to — deleting the conversation, and the abandoned reaper.
 *
 * Runs against the host provider, which needs no container engine and whose
 * "did anything survive?" question is answerable by reading a file back. The
 * container provider's own stop/start/destroy are covered by
 * container-lifecycle.test.ts, which skips without Docker.
 */
const userId = `test-lifecycle-${uuid()}`;
let root: string;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "Lifecycle",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-lifecycle-"));
  process.env.SANDBOX_HOST_ROOT = root;
  process.env.SANDBOX_MODE = "host";
  // Pinned explicitly rather than left to the defaults. Vitest's default pool
  // shares one process across test files, so `process.env` is shared too:
  // settings.test.ts legitimately sets SANDBOX_IDLE_STOP_MS=1 to prove the env
  // pin works, and a case here that meant "the default 4-hour window" would
  // inherit it and see its sandbox stopped instantly. A test asserting
  // something about a window should state the window it means.
  process.env.SANDBOX_IDLE_STOP_MS = String(4 * 60 * 60 * 1000);
  process.env.SANDBOX_REAP_ENABLED = "true";
  process.env.SANDBOX_REAP_AFTER_MS = String(30 * 24 * 60 * 60 * 1000);
  resetServerSettingsCache();
});

afterEach(async () => {
  for (const key of [
    "SANDBOX_HOST_ROOT",
    "SANDBOX_MODE",
    "SANDBOX_IDLE_STOP_MS",
    "SANDBOX_REAP_ENABLED",
    "SANDBOX_REAP_AFTER_MS",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
  resetServerSettingsCache();
  rmSync(root, { recursive: true, force: true });
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
});

async function newConversation(): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ ownerId: userId, title: "Lifecycle", kind: "agent" })
    .returning();
  return row.id;
}

/** A sandbox with a file in it, the way a real tool call would leave one. */
async function workspaceWithFile(conversationId: string, contents = "work in progress") {
  const handle = await getConversationSandbox(userId, conversationId);
  const file = path.join(handle.workdir, "wip.txt");
  await handle.writeFile(file, contents);
  return { handle, file };
}

function rowFor(conversationId: string) {
  return db.query.sandboxes.findFirst({ where: eq(sandboxes.conversationId, conversationId) });
}

describe("idle stop keeps the workspace", () => {
  it("stops an idle sandbox without destroying it, and the next tool call resumes it", async () => {
    const conversationId = await newConversation();
    const { file } = await workspaceWithFile(conversationId);

    // Everything idle: the whole point is that this is a pause.
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");
    expect((await rowFor(conversationId))?.status).toBe("stopped");

    // The resume path a user's next message takes.
    const resumed = await getConversationSandbox(userId, conversationId);
    await expect(resumed.readFile(file)).resolves.toBe("work in progress");
    expect((await rowFor(conversationId))?.status).toBe("running");
  });

  it("leaves a sandbox alone while it is still within the idle window", async () => {
    const conversationId = await newConversation();
    await workspaceWithFile(conversationId);

    await stopIdleSandboxes(Date.now(), "host");
    expect((await rowFor(conversationId))?.status).toBe("running");
  });

  it("resumes across a process restart, from the row alone", async () => {
    const conversationId = await newConversation();
    const { handle, file } = await workspaceWithFile(conversationId);

    // Simulates what a restart leaves: a row marked stopped and nothing in
    // memory. Going through the row is the only way back to the work.
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");

    const recovered = await getConversationSandbox(userId, conversationId);
    expect(recovered.ref).toBe(handle.ref);
    await expect(recovered.readFile(file)).resolves.toBe("work in progress");
  });
});

describe("reaching a sandbox by row resumes it", () => {
  // The REST exec/file routes and the terminal WebSocket find a sandbox by its
  // row, not by conversation, and used to attach and use the handle directly.
  // That was fine while "stopped" meant "gone" — the attach just failed. Once
  // stopping became a pause it meant every one of those routes answered
  // `container … is not running` for a workspace that was intact, with no way
  // back short of sending a chat message. Caught by the e2e spec, which
  // paused a workspace and then could not read it.
  it("wakes a paused sandbox instead of failing on it", async () => {
    const conversationId = await newConversation();
    const { file } = await workspaceWithFile(conversationId);
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");

    const row = await rowFor(conversationId);
    if (!row) throw new Error("no sandbox row");
    const handle = await attachRunningSandbox(row);

    expect(handle).not.toBeNull();
    await expect(handle?.readFile(file)).resolves.toBe("work in progress");
    // The row is corrected too, so a later reader is not told it is paused.
    expect((await rowFor(conversationId))?.status).toBe("running");
  });

  it("returns null for a destroyed sandbox and records it as such", async () => {
    const conversationId = await newConversation();
    await workspaceWithFile(conversationId);
    const row = await rowFor(conversationId);
    if (!row) throw new Error("no sandbox row");
    await destroyConversationSandboxes(conversationId);

    await expect(attachRunningSandbox(row)).resolves.toBeNull();
    expect((await rowFor(conversationId))?.status).toBe("destroyed");
  });
});

describe("the abandoned reaper is the only timer that deletes", () => {
  it("destroys a sandbox nobody has used for the retention window", async () => {
    const conversationId = await newConversation();
    const { handle } = await workspaceWithFile(conversationId);
    // Stop it first, as a real abandoned sandbox would have been: it is the
    // stop that writes last_used_at, and the reaper reads only the row.
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");

    process.env.SANDBOX_REAP_AFTER_MS = "1";
    resetServerSettingsCache();
    await reapAbandonedSandboxes(Date.now() + 60_000, "host");

    expect((await rowFor(conversationId))?.status).toBe("destroyed");
    await expect(handle.exists()).resolves.toBe(false);
  });

  it("destroys nothing when reaping is switched off, however old the sandbox is", async () => {
    const conversationId = await newConversation();
    const { handle } = await workspaceWithFile(conversationId);
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");

    process.env.SANDBOX_REAP_AFTER_MS = "1";
    process.env.SANDBOX_REAP_ENABLED = "false";
    resetServerSettingsCache();

    await reapAbandonedSandboxes(Date.now() + 10 * 365 * 86_400_000, "host");
    expect((await rowFor(conversationId))?.status).toBe("stopped");
    await expect(handle.exists()).resolves.toBe(true);
  });

  it("spares a sandbox this process is holding open, whatever its row says", async () => {
    // The row's last_used_at lags by up to one reaper tick for a live sandbox
    // (it is flushed, not written per tool call), so the in-memory map has to
    // be the tiebreaker or an actively-used workspace could be deleted
    // underneath its own run.
    const conversationId = await newConversation();
    const { handle } = await workspaceWithFile(conversationId);
    // The row now looks abandoned; the in-memory entry says otherwise, and
    // that is the one the reaper must believe.
    await db
      .update(sandboxes)
      .set({ lastUsedAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(sandboxes.conversationId, conversationId));

    process.env.SANDBOX_REAP_AFTER_MS = String(86_400_000);
    resetServerSettingsCache();

    await reapAbandonedSandboxes(Date.now(), "host");
    expect((await rowFor(conversationId))?.status).toBe("running");
    await expect(handle.exists()).resolves.toBe(true);
  });

  it("reclaims a row left 'running' by a crash, rather than treating it as untouchable", async () => {
    // Nothing moves such a row on its own: it is not in this process's map,
    // so no idle timer sees it. Excluding running rows here would make an
    // abandoned sandbox permanently unreclaimable precisely because the
    // server died while it was in use.
    const conversationId = await newConversation();
    const { handle } = await workspaceWithFile(conversationId);

    // Evict it from the in-memory map first (a restart's effect), *then*
    // backdate the row — the stop writes last_used_at itself, so backdating
    // before it would simply be overwritten.
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    resetServerSettingsCache();
    await stopIdleSandboxes(Date.now() + 60_000, "host");
    await db
      .update(sandboxes)
      .set({ status: "running", lastUsedAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(sandboxes.conversationId, conversationId));

    process.env.SANDBOX_REAP_AFTER_MS = String(86_400_000);
    resetServerSettingsCache();

    await reapAbandonedSandboxes(Date.now(), "host");
    expect((await rowFor(conversationId))?.status).toBe("destroyed");
    await expect(handle.exists()).resolves.toBe(false);
  });
});

describe("deleting the conversation reclaims its workspace", () => {
  it("destroys every sandbox belonging to the conversation", async () => {
    const conversationId = await newConversation();
    const { handle } = await workspaceWithFile(conversationId);

    // Scoped to one conversation, so its count *is* predictable — unlike the
    // global sweeps above.
    const destroyed = await destroyConversationSandboxes(conversationId);

    expect(destroyed).toBe(1);
    expect((await rowFor(conversationId))?.status).toBe("destroyed");
    await expect(handle.exists()).resolves.toBe(false);
  });

  it("is idempotent — a second delete finds nothing left to destroy", async () => {
    const conversationId = await newConversation();
    await workspaceWithFile(conversationId);

    expect(await destroyConversationSandboxes(conversationId)).toBe(1);
    expect(await destroyConversationSandboxes(conversationId)).toBe(0);
  });

  it("does not touch another conversation's workspace", async () => {
    const mine = await newConversation();
    const theirs = await newConversation();
    await workspaceWithFile(mine);
    const other = await workspaceWithFile(theirs, "still here");

    await destroyConversationSandboxes(mine);

    await expect(other.handle.readFile(other.file)).resolves.toBe("still here");
    expect((await rowFor(theirs))?.status).toBe("running");
  });
});

describe("a destroyed sandbox is not resumed", () => {
  it("builds a new workspace rather than reattaching to a destroyed row", async () => {
    const conversationId = await newConversation();
    const { handle, file } = await workspaceWithFile(conversationId);
    await destroyConversationSandboxes(conversationId);

    const fresh = await getConversationSandbox(userId, conversationId);

    expect(fresh.ref).not.toBe(handle.ref);
    await expect(fresh.readFile(file)).rejects.toThrow();
  });
});
