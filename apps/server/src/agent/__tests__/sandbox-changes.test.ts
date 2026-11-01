import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxImages, user } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import { sandboxChanges, specOfRow } from "../sandbox-changes.ts";
import { pendingSandboxChanges } from "../sandbox-manager.ts";

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
  const savedPolicy = process.env.SANDBOX_CUSTOM_IMAGES;

  beforeAll(async () => {
    await db.insert(user).values({ id: owner, name: "Changes", email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  });

  beforeEach(() => { process.env.SANDBOX_CUSTOM_IMAGES = "everyone"; });

  afterEach(() => {
    if (savedPolicy === undefined) Reflect.deleteProperty(process.env, "SANDBOX_CUSTOM_IMAGES");
    else process.env.SANDBOX_CUSTOM_IMAGES = savedPolicy;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.ownerId, owner));
    for (const id of imageIds) await db.delete(sandboxImages).where(eq(sandboxImages.id, id));
    await db.delete(user).where(eq(user.id, owner));
  });

  async function image(limits: object | null, ownerId: string | null = null): Promise<Workspace & { kind: "scratch" }> {
    const [row] = await db
      .insert(sandboxImages)
      .values({ ownerId, reference: `example.test/${randomUUID()}:1`, label: "Image", status: "ready", digest, uid: 0, gid: 0, check, limits, createdBy: owner })
      .returning();
    imageIds.push(row.id);
    return { kind: "scratch", image: { id: row.id, scope: ownerId ? "personal" : "shared", label: "Image", reference: row.reference } };
  }

  async function rowIn(workspace: Workspace | null, limits: object, extra: { status?: string; provider?: string; image?: string } = {}) {
    const [conversation] = await db.insert(conversations).values({ ownerId: owner, title: "Changes", kind: "agent", workspace }).returning();
    return { ownerId: owner, conversationId: conversation.id, provider: "container", status: "running", image: digest, limits, ...extra };
  }

  const sized = { memoryMb: 1024, cpus: 2, pids: 4096, kvm: true };
  const made = { memory: 768, cpu: 1, network: false, kvm: false };

  it("compares a shared image's sandbox with the image as it is now", async () => {
    const changes = await pendingSandboxChanges(await rowIn(await image(sized), made));
    expect(changes).toEqual([
      { kind: "memory", fromMb: 768, toMb: 1024 },
      { kind: "cpus", from: 1, to: 2 },
      { kind: "kvm", to: true },
    ]);
  });

  it("says when the image has been pulled again", async () => {
    const row = await rowIn(await image({ memoryMb: 768, cpus: 1, pids: 4096, kvm: false }), made, { image: "repo@sha256:older" });
    expect(await pendingSandboxChanges(row)).toEqual([{ kind: "image" }]);
  });

  it("does not offer a restart for a process limit, which arrives by itself", async () => {
    const row = await rowIn(await image({ memoryMb: 768, cpus: 1, pids: 9000, kvm: false }), { ...made, pids: 100 });
    expect(await pendingSandboxChanges(row)).toEqual([]);
  });

  it("holds a personal image to the defaults, whatever its row says", async () => {
    const row = await rowIn(await image(null, owner), { memory: 512, cpu: 1, network: false, kvm: false });
    expect(await pendingSandboxChanges(row)).toEqual([]);
  });

  it("leaves Loxaic's own image out, which moves with every upgrade", async () => {
    const row = await rowIn(null, { memory: 512, cpu: 1, network: false }, { image: "loxaic-sandbox:older" });
    expect(await pendingSandboxChanges(row)).toEqual([]);
  });

  it("offers nothing a restart could not do", async () => {
    const gone: Workspace = { kind: "scratch", image: { id: randomUUID(), scope: "shared", label: "Gone", reference: "x" } };
    expect(await pendingSandboxChanges(await rowIn(gone, made))).toEqual([]);

    const policy = await rowIn(await image(sized), made);
    process.env.SANDBOX_CUSTOM_IMAGES = "off";
    expect(await pendingSandboxChanges(policy)).toEqual([]);
    process.env.SANDBOX_CUSTOM_IMAGES = "everyone";

    const workspace = await image(sized);
    expect(await pendingSandboxChanges(await rowIn(workspace, made, { provider: "host" }))).toEqual([]);
    expect(await pendingSandboxChanges(await rowIn(workspace, made, { status: "destroyed" }))).toEqual([]);
    expect(await pendingSandboxChanges({ ...(await rowIn(workspace, made)), conversationId: null })).toEqual([]);
    const local: Workspace = { kind: "local", executorId: "e", executorName: "e", path: "/x", isolation: "direct" };
    expect(await pendingSandboxChanges(await rowIn(local, made))).toEqual([]);
  });

  it("reports a paused sandbox too, which waking would not change", async () => {
    const row = await rowIn(await image(sized), made, { status: "stopped" });
    expect((await pendingSandboxChanges(row)).length).toBeGreaterThan(0);
  });
});
