import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { and, db, eq, inArray } from "@loxaic/db";
import { sandboxes, user } from "@loxaic/db/schema";
import { attachActiveSandbox, getConversationSandbox, hasActiveSandbox, stopAllSandboxes } from "../sandbox-manager.ts";
import { getHostProvider } from "../../sandbox/host-provider.ts";

/**
 * Every case here is deliberately scoped to `kind: "host"`.
 *
 * `stopAllSandboxes()` with no filter is global by design — that is the point
 * of it when an admin changes the engine — but test files share one Postgres
 * and run in parallel, so an unfiltered sweep here would stop the container
 * sandbox the MCP end-to-end suite is using.
 *
 * The same sharing is why nothing here asserts on the sweep's **return
 * count**. Host sandboxes were once this file's exclusive property; they are
 * not any more (lifecycle.test.ts creates them too), so the number of rows a
 * global sweep touches at any instant is not a fact this file can predict.
 * Every case asserts on the rows it created instead, which is the property it
 * actually means.
 */
const userId = `test-stopall-${uuid()}`;
let root: string;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "Stop All",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-stopall-"));
  process.env.SANDBOX_HOST_ROOT = root;
});

afterEach(async () => {
  delete process.env.SANDBOX_HOST_ROOT;
  rmSync(root, { recursive: true, force: true });
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
});

async function insertRow(ref: string, status = "running", provider = "host") {
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId: userId,
      containerId: ref,
      provider,
      image: provider === "host" ? "host" : "loxaic-sandbox",
      status,
    })
    .returning();
  return row;
}

describe("stopAllSandboxes", () => {
  it("stops a live host sandbox and marks its row stopped, without destroying it", async () => {
    const handle = await getHostProvider().create(userId, {});
    const file = path.join(handle.workdir, "wip.txt");
    await handle.writeFile(file, "unsaved work");
    const row = await insertRow(handle.ref);
    await expect(handle.isRunning()).resolves.toBe(true);

    const stopped = await stopAllSandboxes("host");
    expect(stopped).toBeGreaterThanOrEqual(1);

    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("stopped");
    expect(after?.stoppedAt).not.toBeNull();
    // The point of the sweep is to retire sandboxes built under settings that
    // no longer apply — not to throw away what is in them. An admin toggling
    // the network switch must not cost every user their working directory,
    // which is exactly what this did while stop() deleted.
    await expect(handle.exists()).resolves.toBe(true);
    await expect(handle.readFile(file)).resolves.toBe("unsaved work");
  });

  it("clears a row left behind by a previous mode, which normal recovery skips", async () => {
    // The recovery query in createEntry() filters on the *current* provider
    // kind, so a row from another kind is ignored but never marked stopped —
    // it would read as "running" forever without this sweep. The ref points
    // at a directory that no longer exists, exactly like a stale row.
    const row = await insertRow(path.join(root, "long-gone"));

    await stopAllSandboxes("host");

    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("stopped");
  });

  it("leaves other kinds alone when filtered", async () => {
    const hostRow = await insertRow(path.join(root, "a-host-one"));
    const containerRow = await insertRow(`fake-container-${uuid()}`, "running", "container");

    await stopAllSandboxes("host");

    const rows = await db.query.sandboxes.findMany({
      where: inArray(sandboxes.id, [hostRow.id, containerRow.id]),
    });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(hostRow.id)).toBe("stopped");
    expect(byId.get(containerRow.id)).toBe("running");
  });

  it("ignores rows that are already stopped", async () => {
    const row = await insertRow(path.join(root, "already-done"), "stopped");
    const before = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });

    await stopAllSandboxes("host");

    // Asserted on the row rather than on the sweep's count: the count is
    // global (see the file header) and another suite's live sandbox would
    // inflate it. "Already stopped" means untouched — same status, same
    // stoppedAt, not re-stamped with a fresh timestamp.
    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("stopped");
    expect(after?.stoppedAt?.getTime()).toBe(before?.stoppedAt?.getTime());
  });

  it("does not touch host sandboxes when only container settings changed", async () => {
    // A container-only change (engine, socket, network toggle) must not
    // interrupt host sandboxes: stopping one no longer destroys it, but it
    // still costs whoever is using it their session mid-task.
    // invalidatedKinds() narrows the sweep; this asserts the narrowing holds.
    const handle = await getHostProvider().create(userId, {});
    await handle.writeFile(path.join(handle.workdir, "work.txt"), "user's work");
    const row = await insertRow(handle.ref);

    await stopAllSandboxes("container");

    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("running");
    await expect(handle.readFile(path.join(handle.workdir, "work.txt"))).resolves.toBe("user's work");
  });

  it("is idempotent — a second sweep finds nothing left", async () => {
    await insertRow(path.join(root, "one"));
    await insertRow(path.join(root, "two"));

    // Asserted on this suite's own rows rather than the sweep's return value.
    // stopAllSandboxes() is global by design, so the count also includes
    // whatever another suite happens to have running in the shared database at
    // that instant — a number this test cannot predict and has no opinion
    // about. What it is actually asserting is that a sweep leaves nothing of
    // its own behind, and that a second one has nothing to do.
    await stopAllSandboxes("host");
    const remaining = await db.query.sandboxes.findMany({
      where: and(eq(sandboxes.ownerId, userId), eq(sandboxes.status, "running")),
    });
    expect(remaining).toHaveLength(0);

    const before = await db.query.sandboxes.findMany({ where: eq(sandboxes.ownerId, userId) });
    await stopAllSandboxes("host");
    const after = await db.query.sandboxes.findMany({ where: eq(sandboxes.ownerId, userId) });
    expect(after.map((r) => r.status).sort()).toEqual(before.map((r) => r.status).sort());
  });
});

/**
 * hasActiveSandbox/attachActiveSandbox never create a sandbox — see their own
 * doc comments in sandbox-manager.ts. These cases share this file's host-only
 * scoping rationale (see the file-level comment above): a real sandbox here
 * is created via getConversationSandbox, which is the only way to populate
 * sandbox-manager's module-private `active` map that these two functions
 * read from.
 */
describe("hasActiveSandbox / attachActiveSandbox", () => {
  it("is false for a conversation id this process has never seen — no false positives", () => {
    expect(hasActiveSandbox(`unknown-${uuid()}`)).toBe(false);
  });

  it("becomes true once a real sandbox is live, and attachActiveSandbox reattaches to it", async () => {
    const conversationId = uuid();
    const prevMode = process.env.SANDBOX_MODE;
    process.env.SANDBOX_MODE = "host";
    try {
      expect(hasActiveSandbox(conversationId)).toBe(false);

      const handle = await getConversationSandbox(userId, conversationId);
      expect(hasActiveSandbox(conversationId)).toBe(true);

      const attached = await attachActiveSandbox(conversationId);
      expect(attached).not.toBeNull();
      const probePath = path.join(handle.workdir, "probe.txt");
      await attached?.writeFile(probePath, "hello from attachActiveSandbox");
      await expect(handle.readFile(probePath)).resolves.toBe("hello from attachActiveSandbox");
    } finally {
      await stopAllSandboxes("host");
      if (prevMode === undefined) delete process.env.SANDBOX_MODE;
      else process.env.SANDBOX_MODE = prevMode;
    }
  });
});
