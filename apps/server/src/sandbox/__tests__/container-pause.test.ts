import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { sandboxes, user } from "@loxaic/db/schema";
import { destroyConversationSandboxes, getConversationSandbox, SandboxLimitError } from "../../agent/sandbox-manager.ts";
import { clearAllocationOverride, setAllocationOverride } from "../../agent/allocation.ts";
import { getContainerProvider } from "../container-provider.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * Real-Docker proof that Pause (#254) frees room in an allocation: the
 * container really stops, its files survive, the next tool call resumes it,
 * and while it is paused another sandbox fits where it did not.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));
const { sandboxRoutes } = await import("../../routes/sandbox.ts");
const { installApiErrorHandler } = await import("../../routes/errors.ts");

const userId = `test-container-pause-${uuid()}`;
const first = randomUUID();
const second = randomUUID();
const app = Fastify();
const dockerReady = await sandboxImageReady();

beforeAll(async () => {
  if (!dockerReady) return;
  await db.insert(user).values({
    id: userId,
    name: "Container Pause Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  currentUser.id = userId;
  installApiErrorHandler(app);
  sandboxRoutes(app);
  await app.ready();
});

afterAll(async () => {
  if (!dockerReady) return;
  await app.close();
  await destroyConversationSandboxes(first);
  await destroyConversationSandboxes(second);
  await clearAllocationOverride(userId);
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
}, 60_000);

describe.skipIf(!dockerReady)("pausing a sandbox to make room", () => {
  it("stops the container, keeps its files, and lets another sandbox start in its place", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    const handle = await getConversationSandbox(userId, first);
    await handle.writeFile(`${handle.workdir}/wip.txt`, "half-finished work");
    await expect(getConversationSandbox(userId, second)).rejects.toBeInstanceOf(SandboxLimitError);

    const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.conversationId, first) });
    if (!row) throw new Error("no row");
    const res = await app.inject({ method: "POST", url: `/v1/sandboxes/${row.id}/pause` });
    expect(res.statusCode).toBe(200);
    expect((await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) }))?.status).toBe("stopped");
    const provider = getContainerProvider();
    expect(await (await provider.attach(row.containerId)).isRunning()).toBe(false);

    // The room it held is free: the second chat's sandbox starts now.
    await getConversationSandbox(userId, second);

    // And the first, its files intact, waits until there is room again.
    await expect(getConversationSandbox(userId, first)).rejects.toBeInstanceOf(SandboxLimitError);
    await destroyConversationSandboxes(second);
    const resumed = await getConversationSandbox(userId, first);
    expect((await resumed.exec(["cat", `${resumed.workdir}/wip.txt`])).stdout).toBe("half-finished work");
  }, 180_000);
});
