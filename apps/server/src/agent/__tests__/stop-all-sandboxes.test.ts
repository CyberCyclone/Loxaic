import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { and, db, eq, inArray } from "@shannon/db";
import { sandboxes, user } from "@shannon/db/schema";
import { stopAllSandboxes } from "../sandbox-manager.ts";
import { getHostProvider } from "../../sandbox/host-provider.ts";

/**
 * Every case here is deliberately scoped to `kind: "host"`.
 *
 * `stopAllSandboxes()` with no filter is global by design — that is the point
 * of it when an admin changes the engine — but test files share one Postgres
 * and run in parallel, so an unfiltered sweep here would stop the container
 * sandbox the MCP end-to-end suite is using. Host sandboxes are plain
 * directories no other suite creates, which makes them a safe subject for the
 * same code path.
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
  root = mkdtempSync(path.join(os.tmpdir(), "shannon-stopall-"));
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
      image: provider === "host" ? "host" : "shannon-sandbox",
      status,
    })
    .returning();
  return row;
}

describe("stopAllSandboxes", () => {
  it("stops a live host sandbox and marks its row stopped", async () => {
    const handle = await getHostProvider().create(userId, {});
    const row = await insertRow(handle.ref);
    await expect(handle.isRunning()).resolves.toBe(true);

    const stopped = await stopAllSandboxes("host");
    expect(stopped).toBeGreaterThanOrEqual(1);

    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("stopped");
    expect(after?.stoppedAt).not.toBeNull();
    await expect(handle.isRunning()).resolves.toBe(false);
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
    await insertRow(path.join(root, "already-done"), "stopped");
    const stopped = await stopAllSandboxes("host");
    expect(stopped).toBe(0);
  });

  it("does not touch host sandboxes when only container settings changed", async () => {
    // The guard against real data loss: a host sandbox's stop() DELETES its
    // working directory, so a container-only change (engine, socket, network
    // toggle) sweeping globally would destroy other users' in-progress work.
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

    expect(await stopAllSandboxes("host")).toBe(2);
    expect(await stopAllSandboxes("host")).toBe(0);

    const remaining = await db.query.sandboxes.findMany({
      where: and(eq(sandboxes.ownerId, userId), eq(sandboxes.status, "running")),
    });
    expect(remaining).toHaveLength(0);
  });
});
