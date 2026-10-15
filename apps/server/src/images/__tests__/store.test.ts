import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { db, eq, inArray } from "@loxaic/db";
import { sandboxImages, user } from "@loxaic/db/schema";

process.env.MCP_ENCRYPTION_KEY ??= "images-store-test-key";

/**
 * The stateful half of custom images (images/store.ts): what a pull does to
 * its row over its whole life. The engine, the registry and the probe are
 * stand-ins controlled per case; the database is real. registry.test.ts runs
 * the same code against a real engine.
 */
const digestA = `docker.io/library/thing@sha256:${"a".repeat(64)}`;
const digestB = `docker.io/library/thing@sha256:${"b".repeat(64)}`;

/** What the next pull does: resolve with these status lines, fail, or wait. */
const engine = {
  pull: (): Promise<string[]> => Promise.resolve([`Digest: ${digestA.split("@")[1]}`]),
  pulls: 0,
  labels: {} as Record<string, Record<string, string>>,
  name: "Docker Engine - Community",
};

const fakeDocker = {
  version: () => Promise.resolve({ Platform: { Name: engine.name } }),
  getImage: (name: string) => ({
    inspect: () => Promise.resolve({ RepoDigests: [], Config: { Labels: engine.labels[name] ?? {} } }),
  }),
};

vi.mock("../../sandbox/container-provider.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../sandbox/container-provider.ts")>();
  return { ...original, sandboxEngine: () => Promise.resolve({ docker: fakeDocker, label: "fake" }) };
});
vi.mock("../pull.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pull.ts")>();
  return {
    ...original,
    pullImage: () => {
      engine.pulls++;
      return engine.pull();
    },
  };
});
vi.mock("../check.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../check.ts")>();
  return { ...original, probeImage: () => Promise.resolve({ uid: 1000, gid: 1000, check: { missing: [], warnings: [] } }) };
});

const store = await import("../store.ts");

const owner = `store-owner-${randomUUID()}`;
const ENV = ["SANDBOX_MODE", "SANDBOX_CUSTOM_IMAGES"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

async function rowOf(id: string) {
  const row = await db.query.sandboxImages.findFirst({ where: eq(sandboxImages.id, id) });
  if (!row) throw new Error("row vanished");
  return row;
}

beforeAll(async () => {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
});

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.SANDBOX_MODE = "container";
  process.env.SANDBOX_CUSTOM_IMAGES = "everyone";
  engine.pull = () => Promise.resolve([`Digest: ${digestA.split("@")[1]}`]);
  engine.pulls = 0;
  engine.labels = {};
  engine.name = "Docker Engine - Community";
});

afterEach(async () => {
  for (const key of ENV) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await db.delete(sandboxImages).where(eq(sandboxImages.createdBy, owner));
});

afterAll(async () => {
  await db.delete(user).where(inArray(user.id, [owner]));
});

describe("an image row over its pulls", () => {
  it("keeps the last good digest and check usable when a later update fails", async () => {
    const view = await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner);
    await store.__waitForPull(view.id);
    expect((await rowOf(view.id)).digest).toBe(digestA);

    engine.pull = () => Promise.reject(new Error("unauthorized: authentication required"));
    await store.repull(owner, view.id);
    await store.__waitForPull(view.id);
    const after = await rowOf(view.id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/refused/);
    expect(after.digest).toBe(digestA);
    expect(store.toImageView(after).usable).toBe(true);
  });

  it("joins a pull already running instead of starting a second", async () => {
    let release!: () => void;
    engine.pull = () => new Promise((resolve) => { release = () => { resolve([`Digest: ${digestB.split("@")[1]}`]); }; });
    const view = await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner);
    await vi.waitFor(() => { expect(engine.pulls).toBe(1); });
    await store.repull(owner, view.id);
    await store.repull(owner, view.id);
    release();
    await store.__waitForPull(view.id);
    expect(engine.pulls).toBe(1);
    expect((await rowOf(view.id)).digest).toBe(digestB);
    // And once it settled, the next request starts a new one.
    engine.pull = () => Promise.resolve([`Digest: ${digestA.split("@")[1]}`]);
    await store.repull(owner, view.id);
    await store.__waitForPull(view.id);
    expect(engine.pulls).toBe(2);
  });

  it("caps one person's pulls at once", async () => {
    const releases: (() => void)[] = [];
    engine.pull = () => new Promise((resolve) => { releases.push(() => { resolve([`Digest: ${digestA.split("@")[1]}`]); }); });
    const ids: string[] = [];
    for (let i = 0; i < store.MAX_PULLS_PER_OWNER; i++) {
      ids.push((await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner)).id);
    }
    await expect(store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner)).rejects.toMatchObject({ status: 429 });
    await vi.waitFor(() => { expect(releases).toHaveLength(store.MAX_PULLS_PER_OWNER); });
    for (const release of releases) release();
    for (const id of ids) await store.__waitForPull(id);
    // Room again once they finish.
    engine.pull = () => Promise.resolve([`Digest: ${digestA.split("@")[1]}`]);
    const next = await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner);
    await store.__waitForPull(next.id);
  });

  it("checks labels on the pinned digest, not on a tag another pull may have moved", async () => {
    // The tag looks clean; the digest this pull pinned carries a reserved label.
    engine.pull = () => Promise.resolve([`Digest: ${digestB.split("@")[1]}`]);
    engine.labels[digestB] = { "loxaic.executor": "x" };
    const view = await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner);
    await store.__waitForPull(view.id);
    const row = await rowOf(view.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/loxaic.executor/);
    expect(row.digest).toBeNull();
  });

  it("fails the row, never the process, when the stored reference no longer parses", async () => {
    const [row] = await db
      .insert(sandboxImages)
      .values({ ownerId: owner, reference: "Not A Reference", label: "bad", status: "failed", createdBy: owner })
      .returning();
    await store.repull(owner, row.id);
    await expect(store.__waitForPull(row.id)).resolves.toBeUndefined();
    const after = await rowOf(row.id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/cannot contain spaces/);
  });

  it("marks pulls a dead process left running as failed at boot", async () => {
    const [row] = await db
      .insert(sandboxImages)
      .values({ ownerId: owner, reference: `docker.io/library/thing:${randomUUID().slice(0, 8)}`, label: "stuck", status: "pulling", createdBy: owner })
      .returning();
    await store.failInterruptedPulls();
    const after = await rowOf(row.id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/restart/);
  });
});

describe("sandbox creation", () => {
  it("refuses an image once the engine is no longer Docker, before anything is pulled", async () => {
    const view = await store.addImage(owner, { reference: `thing:${randomUUID().slice(0, 8)}` }, owner);
    await store.__waitForPull(view.id);
    const { conversations } = await import("@loxaic/db/schema");
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: owner, title: "podman", kind: "agent", workspace: { kind: "scratch", image: { id: view.id, scope: "personal", reference: view.reference, label: "Thing" } } })
      .returning();
    try {
      engine.name = "Podman Engine";
      const pullsBefore = engine.pulls;
      const { getConversationSandbox } = await import("../../agent/sandbox-manager.ts");
      await expect(getConversationSandbox(owner, conv.id)).rejects.toThrow(/need Docker/);
      expect(engine.pulls).toBe(pullsBefore);
    } finally {
      await db.delete(conversations).where(eq(conversations.id, conv.id));
    }
  });
});

describe("the stall timeout", () => {
  it("leaves no timer behind when progress arrives after the pull gave up", async () => {
    const { pullImage } = await vi.importActual<typeof import("../pull.ts")>("../pull.ts");
    const savedStall = process.env.IMAGE_PULL_STALL_MS;
    process.env.IMAGE_PULL_STALL_MS = "60000";
    vi.useFakeTimers();
    try {
      let onProgress!: (event: object) => void;
      const docker = {
        pull: () => Promise.resolve(new PassThrough()),
        modem: { followProgress: (_s: unknown, _done: unknown, progress: (event: object) => void) => { onProgress = progress; } },
      } as unknown as import("dockerode");
      const pulled = pullImage(docker, "docker.io/library/thing:1", null);
      const outcome = expect(pulled).rejects.toThrow(/no progress/);
      await vi.advanceTimersByTimeAsync(60_001);
      await outcome;
      // A queued event lands after the give-up: nothing may be armed again.
      onProgress({ status: "Downloading", id: "layer", progressDetail: { current: 1, total: 2 } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      if (savedStall === undefined) Reflect.deleteProperty(process.env, "IMAGE_PULL_STALL_MS");
      else process.env.IMAGE_PULL_STALL_MS = savedStall;
    }
  });

  it("abandons a pull that sends nothing, and the row says why", async () => {
    const { pullImage } = await vi.importActual<typeof import("../pull.ts")>("../pull.ts");
    const savedStall = process.env.IMAGE_PULL_STALL_MS;
    process.env.IMAGE_PULL_STALL_MS = "100";
    try {
      const silent = new PassThrough();
      const docker = {
        pull: () => Promise.resolve(silent),
        modem: { followProgress: () => undefined },
      } as unknown as import("dockerode");
      await expect(pullImage(docker, "docker.io/library/thing:1", null)).rejects.toThrow(/no progress/);
    } finally {
      if (savedStall === undefined) Reflect.deleteProperty(process.env, "IMAGE_PULL_STALL_MS");
      else process.env.IMAGE_PULL_STALL_MS = savedStall;
    }
  });
});
