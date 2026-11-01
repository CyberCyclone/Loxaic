import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, sandboxImages, user } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import {
  __forgetActiveSandboxForTest,
  applyImageProcessLimit,
  destroyConversationSandboxes,
  getConversationSandbox,
  syncProcessLimit,
} from "../sandbox-manager.ts";
import type { SandboxHandle } from "../../sandbox/provider.ts";
import { DEFAULT_IMAGE_LIMITS } from "../../images/store.ts";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";
import { getContainerProvider } from "../../sandbox/container-provider.ts";
import Docker from "dockerode";

/**
 * A process limit follows the image, unlike memory and CPUs: an admin who
 * raises it for a stuck sandbox should not have to start the chat again. The
 * running ones are updated on save, the paused ones when they wake.
 */
const dockerReady = await sandboxImageReady();
const owner = `test-process-limit-${randomUUID()}`;
const imageRows: string[] = [];

beforeAll(async () => {
  await db.insert(user).values({
    id: owner,
    name: "Process Limit",
    email: `${owner}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, owner));
  await db.delete(conversations).where(eq(conversations.ownerId, owner));
  for (const id of imageRows) await db.delete(sandboxImages).where(eq(sandboxImages.id, id));
  await db.delete(user).where(eq(user.id, owner));
});

async function imageRow(limits: unknown, ownerId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(sandboxImages)
    .values({ ownerId, reference: `example.test/${randomUUID()}:1`, label: "Image", status: "ready", limits, createdBy: owner })
    .returning();
  imageRows.push(row.id);
  return row.id;
}

/** A sandbox row in a conversation of this workspace. */
async function sandboxIn(workspace: Workspace, limits: unknown, containerId: string = randomUUID()): Promise<string> {
  const [conversation] = await db.insert(conversations).values({ ownerId: owner, title: "Limit", kind: "agent", workspace }).returning();
  const [row] = await db
    .insert(sandboxes)
    .values({ ownerId: owner, conversationId: conversation.id, containerId, provider: "container", image: "image", status: "running", limits })
    .returning();
  return row.id;
}

function fakeHandle(setProcessLimit = vi.fn(() => Promise.resolve())) {
  return { handle: { setProcessLimit } as unknown as SandboxHandle, setProcessLimit };
}

async function recordedPids(id: string): Promise<number | undefined> {
  const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, id) });
  return (row?.limits as { pids?: number }).pids;
}

const scratch = (id: string): Workspace => ({ kind: "scratch", image: { id, scope: "shared", label: "Image", reference: "example.test/image:1" } });

describe("syncProcessLimit", () => {
  it("gives a woken sandbox its shared image's current limit, and records it", async () => {
    const id = await sandboxIn(scratch(await imageRow({ memoryMb: 512, cpus: 1, pids: 10_000 })), { memory: 512, cpu: 1, pids: 100, network: true });
    const { handle, setProcessLimit } = fakeHandle();
    await syncProcessLimit(handle, id);
    expect(setProcessLimit).toHaveBeenCalledWith(10_000);
    expect(await recordedPids(id)).toBe(10_000);
    const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, id) });
    expect(row?.limits).toEqual({ memory: 512, cpu: 1, pids: 10_000, network: true });
  });

  it("gives a sandbox of Loxaic's own image the default, though its row recorded none", async () => {
    const id = await sandboxIn({ kind: "scratch" }, { memory: 512, cpu: 1, network: true });
    const { handle, setProcessLimit } = fakeHandle();
    await syncProcessLimit(handle, id);
    expect(setProcessLimit).toHaveBeenCalledWith(DEFAULT_IMAGE_LIMITS.pids);
    expect(await recordedPids(id)).toBe(DEFAULT_IMAGE_LIMITS.pids);
  });

  it("gives a personal image's sandbox the default: only an admin's limits count", async () => {
    const id = await sandboxIn(scratch(await imageRow(null, owner)), { memory: 512, cpu: 1, pids: 100, network: true });
    const { handle, setProcessLimit } = fakeHandle();
    await syncProcessLimit(handle, id);
    expect(setProcessLimit).toHaveBeenCalledWith(DEFAULT_IMAGE_LIMITS.pids);
  });

  it("leaves one already there alone", async () => {
    const id = await sandboxIn(scratch(await imageRow({ memoryMb: 512, cpus: 1, pids: 300 })), { pids: 300 });
    const { handle, setProcessLimit } = fakeHandle();
    await syncProcessLimit(handle, id);
    expect(setProcessLimit).not.toHaveBeenCalled();
  });

  it("leaves one whose image has gone alone", async () => {
    const id = await sandboxIn(scratch(randomUUID()), { pids: 300 });
    const { handle, setProcessLimit } = fakeHandle();
    await syncProcessLimit(handle, id);
    expect(setProcessLimit).not.toHaveBeenCalled();
    expect(await recordedPids(id)).toBe(300);
  });

  it("never fails the wake, and records nothing it did not apply", async () => {
    const id = await sandboxIn(scratch(await imageRow({ memoryMb: 512, cpus: 1, pids: 500 })), { pids: 100 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handle } = fakeHandle(vi.fn(() => Promise.reject(new Error("engine said no"))));
    await expect(syncProcessLimit(handle, id)).resolves.toBeUndefined();
    expect(await recordedPids(id)).toBe(100);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does nothing for a sandbox with no limit of its own", async () => {
    const id = await sandboxIn({ kind: "scratch" }, { pids: 100 });
    await syncProcessLimit({} as SandboxHandle, id);
    expect(await recordedPids(id)).toBe(100);
  });
});

describe.skipIf(!dockerReady)("waking a paused sandbox", () => {
  it("brings it up to the limit, so one from before a change gets it", async () => {
    const [conversation] = await db.insert(conversations).values({ ownerId: owner, title: "Wake", kind: "agent", workspace: { kind: "scratch" } }).returning();
    try {
      const handle = await getConversationSandbox(owner, conversation.id);
      const docker = new Docker();
      // As one made before the default rose, paused since.
      await handle.setProcessLimit?.(100);
      await handle.stop();
      await db
        .update(sandboxes)
        .set({ status: "stopped", limits: { memory: 512, cpu: 1, pids: 100, network: false } })
        .where(eq(sandboxes.containerId, handle.ref));
      __forgetActiveSandboxForTest(conversation.id);
      expect((await docker.getContainer(handle.ref).inspect()).HostConfig.PidsLimit).toBe(100);

      const woken = await getConversationSandbox(owner, conversation.id);

      expect(woken.ref).toBe(handle.ref);
      expect((await docker.getContainer(handle.ref).inspect()).HostConfig.PidsLimit).toBe(DEFAULT_IMAGE_LIMITS.pids);
      const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.containerId, handle.ref) });
      expect((row?.limits as { pids?: number }).pids).toBe(DEFAULT_IMAGE_LIMITS.pids);
    } finally {
      await destroyConversationSandboxes(conversation.id);
    }
  }, 120_000);
});

describe.skipIf(!dockerReady)("applyImageProcessLimit", () => {
  it("raises a running sandbox of that image in place, and touches nothing else", async () => {
    const imageId = await imageRow({ memoryMb: 512, cpus: 1, pids: 200 });
    const handle = await getContainerProvider().create(`pids-apply-${Date.now().toString(36)}`, { limits: { pids: 200 } });
    const other = await getContainerProvider().create(`pids-other-${Date.now().toString(36)}`, { limits: { pids: 200 } });
    try {
      const id = await sandboxIn(scratch(imageId), { memory: 512, cpu: 1, pids: 200, network: true }, handle.ref);
      const otherId = await sandboxIn({ kind: "scratch" }, { pids: 200 }, other.ref);
      const docker = new Docker();
      const memoryBefore = (await docker.getContainer(handle.ref).inspect()).HostConfig.Memory;

      await applyImageProcessLimit(imageId, 5000);

      const info = await docker.getContainer(handle.ref).inspect();
      expect(info.HostConfig.PidsLimit).toBe(5000);
      expect(info.HostConfig.Memory).toBe(memoryBefore);
      expect(await recordedPids(id)).toBe(5000);
      expect((await docker.getContainer(other.ref).inspect()).HostConfig.PidsLimit).toBe(200);
      expect(await recordedPids(otherId)).toBe(200);
    } finally {
      await handle.destroy().catch(() => undefined);
      await other.destroy().catch(() => undefined);
    }
  }, 120_000);

  it("leaves a sandbox it could not reach as it was", async () => {
    const imageId = await imageRow({ memoryMb: 512, cpus: 1, pids: 200 });
    const id = await sandboxIn(scratch(imageId), { pids: 200 }, "no-such-container");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(applyImageProcessLimit(imageId, 5000)).resolves.toBeUndefined();
    expect(await recordedPids(id)).toBe(200);
    warn.mockRestore();
  });
});
