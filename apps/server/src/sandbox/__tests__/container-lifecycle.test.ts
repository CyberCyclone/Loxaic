import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { sandboxes, user } from "@loxaic/db/schema";
import { getConversationSandbox, sweepOrphanSandboxes } from "../../agent/sandbox-manager.ts";
import { getContainerProvider } from "../container-provider.ts";
import type { SandboxHandle } from "../provider.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * Real-Docker proof that a stopped container survives, and that resuming it
 * gives back the same filesystem.
 *
 * Nothing short of a real container can establish this. The behaviour it
 * guards is a `HostConfig` flag (`AutoRemove: false`) that only the engine
 * acts on: with it set the wrong way every assertion here would still pass
 * against a fake, and the failure would only appear as users losing a day's
 * work to a lunch break. The container-gone case is checked too, because
 * "paused" and "removed" are the two answers the manager has to tell apart and
 * `isRunning()` reports false for both.
 */
const userId = `test-container-lifecycle-${uuid()}`;
const conversationId = randomUUID();
let handle: SandboxHandle | undefined;

const dockerReady = await sandboxImageReady();

beforeAll(async () => {
  if (!dockerReady) return;
  await db.insert(user).values({
    id: userId,
    name: "Container Lifecycle Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  handle = await getConversationSandbox(userId, conversationId);
}, 120_000);

afterAll(async () => {
  if (!dockerReady) return;
  await handle?.destroy().catch(() => undefined);
  // By owner, not by conversation: the destroy case below creates a second
  // sandbox under its own conversation id, and a cleanup scoped to the first
  // would leave that row behind to fail the user delete on a foreign key.
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
}, 60_000);

describe.skipIf(!dockerReady)("container provider — stop, resume, destroy", () => {
  it("keeps the container and its files across a stop, and resumes where it left off", async () => {
    if (!handle) throw new Error("no sandbox");
    const file = `${handle.workdir}/wip.txt`;
    await handle.writeFile(file, "half-finished work");

    await handle.stop();

    // Not running, but very much still there — the distinction the whole
    // stop/destroy split rests on.
    await expect(handle.isRunning()).resolves.toBe(false);
    await expect(handle.exists()).resolves.toBe(true);

    await handle.start();

    await expect(handle.isRunning()).resolves.toBe(true);
    await expect(handle.readFile(file)).resolves.toBe("half-finished work");
  }, 120_000);

  it("start() is a no-op on a container that is already running", async () => {
    if (!handle) throw new Error("no sandbox");
    await handle.start();
    await expect(handle.isRunning()).resolves.toBe(true);
  }, 60_000);

  it("the boot sweep leaves a paused sandbox alone, and reclaims an unclaimed one", async () => {
    // Two halves, both of which silently do the wrong thing on their own.
    //
    // Containers now survive the server, so an orphan (one whose row is gone)
    // comes to rest *stopped* — the state dockerode's default listing cannot
    // see, so without `all: true` every orphan accumulates on the host
    // forever. But once the sweep can see stopped containers, a paused
    // sandbox looks exactly like an orphan, so a sweep that only counted
    // "running" rows as claims would delete a user's workspace at every boot.
    if (!handle) throw new Error("no sandbox");
    const paused = await getConversationSandbox(userId, randomUUID());
    const pausedFile = `${paused.workdir}/kept.txt`;
    await paused.writeFile(pausedFile, "keep me");
    await paused.stop();

    // Created straight through the provider, so nothing tracks it: no row and
    // no entry in the manager's in-memory map. That *is* an orphan — precisely
    // what a crash between `provider.create` and the row insert leaves behind.
    // (Going through getConversationSandbox would leave it in the live map,
    // which the sweep correctly counts as a claim.)
    const orphan = await getContainerProvider().create(userId, {});
    await orphan.stop();

    // Scoped to this suite's user: unscoped, the sweep pauses every other
    // suite's live sandbox and destroys every rowless container on the engine,
    // extraction pools included, in whichever workers happen to be running.
    await sweepOrphanSandboxes(userId);

    await expect(paused.exists()).resolves.toBe(true);
    await paused.start();
    await expect(paused.readFile(pausedFile)).resolves.toBe("keep me");
    await expect(orphan.exists()).resolves.toBe(false);
  }, 180_000);

  it("destroy() removes it, and start() then throws rather than reporting success", async () => {
    if (!handle) throw new Error("no sandbox");
    // Its own sandbox, so destroying it cannot disturb the cases above.
    const doomed = await getConversationSandbox(userId, randomUUID());
    await doomed.writeFile(`${doomed.workdir}/gone.txt`, "x");

    await doomed.destroy();

    await expect(doomed.exists()).resolves.toBe(false);
    await expect(doomed.start()).rejects.toThrow();
  }, 120_000);
});
