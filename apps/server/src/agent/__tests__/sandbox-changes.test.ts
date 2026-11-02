import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, sandboxImages, user } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import { sandboxChanges, specOfRow } from "../sandbox-changes.ts";
import { pendingSandboxChanges } from "../sandbox-manager.ts";

// The engine check, which asks the real engine otherwise: whether one answers
// is not what these cases are about.
const blocked = vi.hoisted(() => vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)));
vi.mock("../../images/store.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../images/store.ts")>();
  return { ...original, customImagesBlocked: blocked };
});

/**
 * What a chat is told its sandbox has yet to pick up: what a restart would
 * change, and nothing it could not.
 */
describe("sandboxChanges", () => {
  const made = { memoryMb: 512, cpus: 1, network: false, kvm: false, image: "repo@sha256:a" };

  it("finds nothing when nothing changed", () => {
    expect(sandboxChanges(made, { ...made })).toEqual([]);
  });

  it("reports each part that changed, with what it becomes", () => {
    expect(sandboxChanges(made, { ...made, memoryMb: 1024 })).toEqual([{ kind: "memory", fromMb: 512, toMb: 1024 }]);
    expect(sandboxChanges(made, { ...made, cpus: 6 })).toEqual([{ kind: "cpus", from: 1, to: 6 }]);
    expect(sandboxChanges(made, { ...made, network: true })).toEqual([{ kind: "network", to: true }]);
    expect(sandboxChanges(made, { ...made, kvm: true })).toEqual([{ kind: "kvm", to: true }]);
    expect(sandboxChanges(made, { ...made, image: "repo@sha256:b" })).toEqual([{ kind: "image" }]);
  });

  it("reports all of them at once", () => {
    expect(sandboxChanges(made, { memoryMb: 1024, cpus: 2, network: true, kvm: true, image: "repo@sha256:b" })).toHaveLength(5);
  });

  it("never reports what either side does not know", () => {
    expect(sandboxChanges({}, made)).toEqual([]);
    expect(sandboxChanges(made, {})).toEqual([]);
  });
});

describe("specOfRow", () => {
  it("reads a row, and leaves what it never recorded unknown", () => {
    expect(specOfRow({ image: "i", limits: { memory: 512, cpu: 1, pids: 100, network: true } })).toEqual({
      memoryMb: 512, cpus: 1, network: true, kvm: undefined, image: "i",
    });
    expect(specOfRow({ image: "i", limits: null })).toMatchObject({ memoryMb: undefined, image: "i" });
  });
});

describe("pendingSandboxChanges", () => {
  const owner = `test-sandbox-changes-${randomUUID()}`;
  const imageIds: string[] = [];
  const digest = `repo@sha256:${"a".repeat(64)}`;
  const check = { missing: [], warnings: [] };
  const ENV = ["SANDBOX_CUSTOM_IMAGES", "SANDBOX_MODE"] as const;
  const saved: Partial<Record<(typeof ENV)[number], string>> = {};

  beforeAll(async () => {
    await db.insert(user).values({ id: owner, name: "Changes", email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  });

  beforeEach(() => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env.SANDBOX_CUSTOM_IMAGES = "everyone";
    process.env.SANDBOX_MODE = "container";
    blocked.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const key of ENV) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, owner));
    await db.delete(conversations).where(eq(conversations.ownerId, owner));
    for (const id of imageIds) await db.delete(sandboxImages).where(eq(sandboxImages.id, id));
    await db.delete(user).where(eq(user.id, owner));
  });

  async function image(limits: object | null, ownerId: string | null = null, extra: { uid?: number | null } = {}): Promise<Workspace & { kind: "scratch" }> {
    const [row] = await db
      .insert(sandboxImages)
      .values({ ownerId, reference: `example.test/${randomUUID()}:1`, label: "Image", status: "ready", digest, uid: 0, gid: 0, check, limits, createdBy: owner, ...extra })
      .returning();
    imageIds.push(row.id);
    return { kind: "scratch", image: { id: row.id, scope: ownerId ? "personal" : "shared", label: "Image", reference: row.reference } };
  }

  interface RowExtra { status?: string; provider?: string; image?: string; createdAt?: Date }

  /** A conversation of this workspace, with one sandbox row, or several. */
  async function chatWith(workspace: Workspace | null, ...rows: [limits: object, extra?: RowExtra][]) {
    const [conversation] = await db.insert(conversations).values({ ownerId: owner, title: "Changes", kind: "agent", workspace }).returning();
    const ids: string[] = [];
    for (const [limits, extra = {}] of rows) {
      const [row] = await db
        .insert(sandboxes)
        .values({ ownerId: owner, conversationId: conversation.id, containerId: randomUUID(), provider: "container", status: "running", image: digest, limits, ...extra })
        .returning();
      ids.push(row.id);
    }
    return { conversationId: conversation.id, ids };
  }

  async function changesFor(workspace: Workspace | null, limits: object, extra: RowExtra = {}) {
    const { conversationId } = await chatWith(workspace, [limits, extra]);
    return (await pendingSandboxChanges(conversationId))?.changes ?? null;
  }

  const sized = { memoryMb: 1024, cpus: 2, pids: 4096, kvm: true };
  const made = { memory: 768, cpu: 1, network: false, kvm: false };

  it("compares a shared image's sandbox with the image as it is now", async () => {
    expect(await changesFor(await image(sized), made)).toEqual([
      { kind: "memory", fromMb: 768, toMb: 1024 },
      { kind: "cpus", from: 1, to: 2 },
      { kind: "kvm", to: true },
    ]);
  });

  it("says when the image has been pulled again", async () => {
    const workspace = await image({ memoryMb: 768, cpus: 1, pids: 4096, kvm: false });
    expect(await changesFor(workspace, made, { image: "repo@sha256:older" })).toEqual([{ kind: "image" }]);
  });

  it("does not offer a restart for a process limit, which arrives by itself", async () => {
    expect(await changesFor(await image({ memoryMb: 768, cpus: 1, pids: 9000, kvm: false }), { ...made, pids: 100 })).toEqual([]);
  });

  it("holds a personal image to the defaults, whatever its row says", async () => {
    expect(await changesFor(await image(null, owner), { memory: 512, cpu: 1, network: false, kvm: false })).toEqual([]);
  });

  it("leaves Loxaic's own image out, which moves with every upgrade", async () => {
    expect(await changesFor(null, { memory: 512, cpu: 1, network: false }, { image: "loxaic-sandbox:older" })).toEqual([]);
  });

  it("reports them on the sandbox a restart would replace: a running one before a newer paused one", async () => {
    const { conversationId, ids } = await chatWith(
      await image(sized),
      [made, { status: "running", createdAt: new Date(Date.now() - 60_000) }],
      [made, { status: "stopped" }],
    );
    expect((await pendingSandboxChanges(conversationId))?.sandboxId).toBe(ids[0]);
  });

  it("offers nothing a restart could not do", async () => {
    const gone: Workspace = { kind: "scratch", image: { id: randomUUID(), scope: "shared", label: "Gone", reference: "x" } };
    expect(await changesFor(gone, made)).toBeNull();

    const policy = await chatWith(await image(sized), [made]);
    process.env.SANDBOX_CUSTOM_IMAGES = "off";
    expect(await pendingSandboxChanges(policy.conversationId)).toBeNull();
    process.env.SANDBOX_CUSTOM_IMAGES = "everyone";

    const workspace = await image(sized);
    expect(await changesFor(workspace, made, { provider: "host" })).toBeNull();
    expect(await changesFor(workspace, made, { status: "destroyed" })).toBeNull();
    expect(await pendingSandboxChanges(randomUUID())).toBeNull();
    const local: Workspace = { kind: "local", executorId: "e", executorName: "e", path: "/x", isolation: "direct" };
    expect(await changesFor(local, made)).toBeNull();
  });

  it("offers nothing on a server that no longer makes containers", async () => {
    const { conversationId } = await chatWith(await image(sized), [made]);
    for (const mode of ["off", "host"]) {
      process.env.SANDBOX_MODE = mode;
      expect(await pendingSandboxChanges(conversationId)).toBeNull();
    }
  });

  it("offers nothing for an image the engine can't use now, or whose user was never read", async () => {
    const { conversationId } = await chatWith(await image(sized), [made]);
    blocked.mockResolvedValue("Custom images need Docker as the container engine.");
    expect(await pendingSandboxChanges(conversationId)).toBeNull();
    blocked.mockResolvedValue(null);
    expect(await changesFor(await image(sized, null, { uid: null }), made)).toBeNull();
  });

  it("offers nothing for a GitHub workspace whose owner has disconnected GitHub", async () => {
    const github: Workspace = {
      kind: "github",
      repo: "owner/name",
      baseBranch: "main",
      branch: "loxaic/x",
      cloneUrl: "https://github.com/owner/name.git",
    };
    expect(await changesFor(github, { memory: 256, cpu: 1, network: false })).toBeNull();
  });

  it("reports a paused sandbox too, which waking would not change", async () => {
    expect((await changesFor(await image(sized), made, { status: "stopped" }))?.length).toBeGreaterThan(0);
  });
});
