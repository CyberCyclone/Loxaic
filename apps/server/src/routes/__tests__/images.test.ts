import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, registryLogins, sandboxImages, user } from "@loxaic/db/schema";

process.env.MCP_ENCRYPTION_KEY ??= "images-routes-test-key";

/**
 * `/v1/images…` and `/v1/admin/images…` through a real Fastify instance and
 * the real database (#253). Only authentication and the engine are stubbed:
 * the engine claims to be Docker, and every pull fails at once, as one to a
 * registry that has never heard of the image would — so nothing here reaches
 * a real registry. What the real ones do is registry.test.ts's job.
 *
 * Held here: a person's images and logins are theirs alone (an admin
 * included), the policy gates every write, no response carries a secret, and
 * a workspace can only name an image its owner may use.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!currentUser.id.startsWith("admin")) {
      reply.code(403).send({ error: "Admin access required" });
      throw new Error("Forbidden");
    }
    return Promise.resolve(currentUser.id);
  },
}));

vi.mock("../../sandbox/container-provider.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../sandbox/container-provider.ts")>();
  const fakeDocker = { version: () => Promise.resolve({ Platform: { Name: "Docker Engine - Community" } }) };
  return { ...original, sandboxEngine: () => Promise.resolve({ docker: fakeDocker, label: "fake" }) };
});

vi.mock("../../images/pull.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../images/pull.ts")>();
  return { ...original, pullImage: () => Promise.reject(new Error("manifest unknown")) };
});

const { imageRoutes } = await import("../images.ts");
const { sandboxRoutes } = await import("../sandbox.ts");
const { parseWorkspaceInput, WorkspaceError, effectiveWorkspace } = await import("../../agent/workspace.ts");
const { __waitForPull } = await import("../../images/store.ts");

const admin = `admin-images-${randomUUID()}`;
const alice = `alice-images-${randomUUID()}`;
const bob = `bob-images-${randomUUID()}`;
const ids = [admin, alice, bob];
const conversationIds: string[] = [];
const app = Fastify();
imageRoutes(app);
sandboxRoutes(app);

const ENV = ["SANDBOX_MODE", "SANDBOX_CUSTOM_IMAGES"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
const good = { missing: [], warnings: [] };
const digest = (n: string) => `docker.io/library/x@sha256:${n.repeat(64)}`;

function as(id: string) {
  currentUser.id = id;
  return app;
}

async function call(id: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await as(id).inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>(), raw: res.body };
}

/** A row as a good pull leaves it, written directly: these tests are about
 * who may see and use rows, not about pulling. */
async function readyImage(ownerId: string | null, label: string, check: object = good) {
  const [row] = await db
    .insert(sandboxImages)
    .values({ ownerId, reference: `docker.io/library/${label.toLowerCase()}:${randomUUID().slice(0, 8)}`, label, status: "ready", digest: digest("c"), uid: 0, gid: 0, check, createdBy: ownerId ?? admin })
    .returning();
  return row;
}

beforeAll(async () => {
  await app.ready();
  for (const id of ids) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, role: id === admin ? "admin" : null, createdAt: new Date(), updatedAt: new Date() });
  }
});

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.SANDBOX_MODE = "container";
  process.env.SANDBOX_CUSTOM_IMAGES = "everyone";
});

afterEach(async () => {
  for (const key of ENV) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await db.delete(sandboxImages).where(inArray(sandboxImages.createdBy, ids));
  await db.delete(registryLogins).where(inArray(registryLogins.createdBy, ids));
});

afterAll(async () => {
  if (conversationIds.length > 0) await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  await db.delete(user).where(inArray(user.id, ids));
  await app.close();
});

describe("a person's own images and logins", () => {
  it("are invisible and untouchable to everyone else, an admin included", async () => {
    const login = await call(alice, "PUT", "/v1/images/mine/logins", { registry: "ghcr.io", username: "alice", password: "alice-secret-pw" });
    expect(login.status).toBe(200);
    const added = await call(alice, "POST", "/v1/images/mine", { reference: "ghcr.io/alice/tool:1", label: "Alice's tool" });
    expect(added.status).toBe(200);
    const id = added.body.id as string;
    await __waitForPull(id);

    for (const other of [bob, admin]) {
      expect((await call(other, "GET", "/v1/images/mine")).body.images).toEqual([]);
      expect((await call(other, "GET", "/v1/images/mine/logins")).body.logins).toEqual([]);
      expect((await call(other, "DELETE", `/v1/images/mine/${id}`)).status).toBe(404);
      expect((await call(other, "PATCH", `/v1/images/mine/${id}`, { label: "mine now" })).status).toBe(404);
      expect((await call(other, "POST", `/v1/images/mine/${id}/pull`)).status).toBe(404);
      expect((await call(other, "DELETE", `/v1/images/mine/logins/${login.body.id as string}`)).status).toBe(404);
    }
    // Nor do they appear among the shared ones an admin manages.
    const shared = (await call(admin, "GET", "/v1/admin/images")).body.images as { id: string }[];
    expect(shared.map((i) => i.id)).not.toContain(id);

    const mine = (await call(alice, "GET", "/v1/images/mine")).body.images as { id: string; status: string; error: string }[];
    expect(mine.map((i) => i.id)).toEqual([id]);
    expect(mine[0].status).toBe("failed");
    expect(mine[0].error).toMatch(/was not found on ghcr.io/);
  });

  it("refuses a login with no registry rather than storing it as Docker Hub's", async () => {
    for (const registry of [undefined, "", "   "]) {
      const res = await call(alice, "PUT", "/v1/images/mine/logins", { registry, username: "alice", password: "ghp-not-for-hub" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/registry is required/);
    }
    expect((await call(alice, "GET", "/v1/images/mine/logins")).body.logins).toEqual([]);
  });

  it("answers 404, not 500, for a login id that is not a uuid", async () => {
    expect((await call(alice, "DELETE", `/v1/images/mine/logins/${"-".repeat(36)}`)).status).toBe(404);
    expect((await call(alice, "DELETE", `/v1/images/mine/logins/${"a".repeat(36)}`)).status).toBe(404);
  });

  it("caps how many images, and pulls at once, one person can ask for", async () => {
    const { MAX_PERSONAL_IMAGES } = await import("../../images/store.ts");
    for (let i = 0; i < MAX_PERSONAL_IMAGES; i++) await readyImage(bob, `Cap${String(i)}`);
    const res = await call(bob, "POST", "/v1/images/mine", { reference: "ubuntu" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/at most/);
  });

  it("never return a login's password, in any response", async () => {
    const saved = await call(alice, "PUT", "/v1/images/mine/logins", { registry: "https://index.docker.io/v1/", username: "alice", password: "never-shown-pw" });
    expect(saved.body).toMatchObject({ registry: "docker.io", username: "alice" });
    expect(saved.raw).not.toContain("never-shown-pw");
    const listed = await call(alice, "GET", "/v1/images/mine/logins");
    expect(listed.raw).not.toContain("never-shown-pw");
    const stored = await db.query.registryLogins.findFirst({ where: eq(registryLogins.createdBy, alice) });
    expect(stored?.encryptedSecret).not.toContain("never-shown-pw");
  });
});

describe("the policy", () => {
  it("refuses every write while custom images are off, and leaves listing and deleting open", async () => {
    const row = await readyImage(alice, "Kept");
    process.env.SANDBOX_CUSTOM_IMAGES = "off";
    expect((await call(alice, "POST", "/v1/images/mine", { reference: "ubuntu" })).status).toBe(403);
    expect((await call(alice, "PUT", "/v1/images/mine/logins", { registry: "ghcr.io", username: "a", password: "pw12" })).status).toBe(403);
    expect((await call(alice, "POST", `/v1/images/mine/${row.id}/pull`)).status).toBe(403);
    expect((await call(admin, "POST", "/v1/admin/images", { reference: "ubuntu" })).status).toBe(403);
    expect((await call(alice, "GET", "/v1/images/mine")).status).toBe(200);
    expect((await call(alice, "DELETE", `/v1/images/mine/${row.id}`)).status).toBe(200);
  });

  it("lets only admins add shared images, and nobody their own, when set to shared", async () => {
    process.env.SANDBOX_CUSTOM_IMAGES = "shared";
    expect((await call(alice, "POST", "/v1/images/mine", { reference: "ubuntu" })).status).toBe(403);
    expect((await call(admin, "POST", "/v1/images/mine", { reference: "ubuntu" })).status).toBe(403);
    expect((await call(alice, "POST", "/v1/admin/images", { reference: "ubuntu" })).status).toBe(403);
    const added = await call(admin, "POST", "/v1/admin/images", { reference: "ubuntu", limits: { memoryMb: 2048, cpus: 2, pids: 500 } });
    expect(added.status).toBe(200);
    expect(added.body.limits).toEqual({ memoryMb: 2048, cpus: 2, pids: 500 });
    await __waitForPull(added.body.id as string);
  });

  it("refuses writes, with the reason, when the server cannot run custom images", async () => {
    process.env.SANDBOX_MODE = "host";
    const res = await call(alice, "POST", "/v1/images/mine", { reference: "ubuntu" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/container sandbox/);
  });

  it("bounds a shared image's limits and keeps them off personal images", async () => {
    expect((await call(admin, "POST", "/v1/admin/images", { reference: "ubuntu", limits: { memoryMb: 128 } })).status).toBe(400);
    expect((await call(admin, "POST", "/v1/admin/images", { reference: "ubuntu", limits: { pids: 1e9 } })).status).toBe(400);
    expect((await call(alice, "POST", "/v1/images/mine", { reference: "ubuntu", limits: { memoryMb: 1024 } })).status).toBe(400);
    expect((await call(alice, "POST", "/v1/images/mine", { reference: "Not A Name" })).status).toBe(400);
  });
});

describe("what the chooser offers", () => {
  it("lists usable shared images and only the caller's own", async () => {
    const shared = await readyImage(null, "Shared");
    const alices = await readyImage(alice, "Alices");
    const broken = await readyImage(alice, "Broken", { missing: ["setsid"], warnings: [] });
    const noGit = await readyImage(null, "NoGit", { missing: [], warnings: [{ code: "git", message: "No git" }] });

    const forAlice = (await call(alice, "GET", "/v1/images")).body.images as { id: string; hasGit: boolean }[];
    expect(forAlice.map((i) => i.id).sort()).toEqual([shared.id, alices.id, noGit.id].sort());
    expect(forAlice.find((i) => i.id === noGit.id)?.hasGit).toBe(false);
    expect(forAlice.map((i) => i.id)).not.toContain(broken.id);

    const forBob = (await call(bob, "GET", "/v1/images")).body.images as { id: string }[];
    expect(forBob.map((i) => i.id).sort()).toEqual([shared.id, noGit.id].sort());

    process.env.SANDBOX_CUSTOM_IMAGES = "shared";
    const sharedOnly = (await call(alice, "GET", "/v1/images")).body.images as { id: string }[];
    expect(sharedOnly.map((i) => i.id)).not.toContain(alices.id);
    process.env.SANDBOX_CUSTOM_IMAGES = "off";
    expect((await call(alice, "GET", "/v1/images")).body.images).toEqual([]);
  });
});

describe("choosing an image for a workspace", () => {
  it("records the owner's own or a shared image, and refuses anyone else's", async () => {
    const alices = await readyImage(alice, "Alices");
    const shared = await readyImage(null, "Shared");

    const own = await parseWorkspaceInput({ kind: "scratch", image: { id: alices.id } }, { userId: alice });
    expect(own).toEqual({ kind: "scratch", image: { id: alices.id, scope: "personal", reference: alices.reference, label: "Alices" } });
    expect(effectiveWorkspace(own)).toEqual(own);

    const viaShared = await parseWorkspaceInput({ kind: "scratch", image: { id: shared.id } }, { userId: bob });
    expect(viaShared).toMatchObject({ kind: "scratch", image: { id: shared.id, scope: "shared" } });

    await expect(parseWorkspaceInput({ kind: "scratch", image: { id: alices.id } }, { userId: bob })).rejects.toThrow(WorkspaceError);
    await expect(parseWorkspaceInput({ kind: "scratch", image: { id: randomUUID() } }, { userId: bob })).rejects.toThrow(/no longer exists/);
  });

  it("refuses a failed image, a scope the policy no longer allows, git-less images for GitHub, and any image for a local folder", async () => {
    const broken = await readyImage(alice, "Broken", { missing: ["realpath"], warnings: [] });
    const noGit = await readyImage(null, "NoGit", { missing: [], warnings: [{ code: "git", message: "No git" }] });
    const alices = await readyImage(alice, "Alices");

    await expect(parseWorkspaceInput({ kind: "scratch", image: { id: broken.id } }, { userId: alice })).rejects.toThrow(/not been pulled/);
    await expect(parseWorkspaceInput({ kind: "github", repo: "o/r", image: { id: noGit.id } }, { userId: alice })).rejects.toThrow(/no git/);
    await expect(parseWorkspaceInput({ kind: "local", executorId: "x", path: "/tmp", image: { id: alices.id } }, { userId: alice })).rejects.toThrow(/own image/);
    process.env.SANDBOX_CUSTOM_IMAGES = "shared";
    await expect(parseWorkspaceInput({ kind: "scratch", image: { id: alices.id } }, { userId: alice })).rejects.toThrow(/only shared/);
  });

  it("will not let a built-in sandbox be planted for a conversation that runs in an image", async () => {
    const shared = await readyImage(null, "Shared");
    const id = randomUUID();
    conversationIds.push(id);
    await db.insert(conversations).values({
      id,
      ownerId: alice,
      title: "image",
      kind: "agent",
      workspace: { kind: "scratch", image: { id: shared.id, scope: "shared", reference: shared.reference, label: "Shared" } },
    });
    const res = await call(alice, "POST", "/v1/sandboxes", { conversation_id: id });
    expect(res.status).toBe(409);
  });
});
