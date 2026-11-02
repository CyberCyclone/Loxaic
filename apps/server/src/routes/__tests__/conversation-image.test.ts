import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, sandboxes, sandboxImages, user } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";

process.env.MCP_ENCRYPTION_KEY ??= "conversation-image-test-key";

/**
 * `POST /v1/conversations/:id/image` (#253): who may move a conversation to
 * another image, and that nothing changes when it can't. Auth stubbed,
 * everything else real. Moving a live container is registry.test.ts's job,
 * against a real engine; here a conversation either has no sandbox yet (only
 * its workspace changes) or one that cannot be moved.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { sandboxRoutes } = await import("../sandbox.ts");
const { claimConversation, registerRun, unregisterRun } = await import("../../streams/registry.ts");
const { watchConversationEvents } = await import("../../streams/watchers.ts");
const { destroyConversationSandboxes, getConversationSandbox } = await import("../../agent/sandbox-manager.ts");
const { clearAllocationOverride, setAllocationOverride } = await import("../../agent/allocation.ts");
const { sandboxImageReady } = await import("../../sandbox/__tests__/docker-available.ts");
const dockerReady = await sandboxImageReady();

const owner = `img-owner-${randomUUID()}`;
const editor = `img-editor-${randomUUID()}`;
const ids = [owner, editor];
const app = Fastify();
conversationRoutes(app);
sandboxRoutes(app);
const savedPolicy = process.env.SANDBOX_CUSTOM_IMAGES;
const savedMode = process.env.SANDBOX_MODE;
const good = { missing: [], warnings: [] };

async function readyImage(ownerId: string | null, label: string) {
  const [row] = await db
    .insert(sandboxImages)
    .values({ ownerId, reference: `docker.io/library/${label.toLowerCase()}:${randomUUID().slice(0, 8)}`, label, status: "ready", digest: `docker.io/library/x@sha256:${"d".repeat(64)}`, uid: 0, gid: 0, check: good, createdBy: ownerId ?? owner })
    .returning();
  return row;
}

async function conversation(kind: "agent" | "chat", workspace: Workspace | null = null): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: owner, title: "img", kind, workspace }).returning();
  return row.id;
}

async function workspaceOf(id: string): Promise<unknown> {
  return (await db.query.conversations.findFirst({ where: eq(conversations.id, id), columns: { workspace: true } }))?.workspace;
}

function post(as: string, id: string, image: unknown) {
  currentUser.id = as;
  return app.inject({ method: "POST", url: `/v1/conversations/${id}/image`, payload: { image } });
}

beforeAll(async () => {
  await app.ready();
  for (const id of ids) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }
});

beforeEach(() => {
  process.env.SANDBOX_CUSTOM_IMAGES = "everyone";
  process.env.SANDBOX_MODE = "container";
});

afterEach(() => {
  if (savedPolicy === undefined) Reflect.deleteProperty(process.env, "SANDBOX_CUSTOM_IMAGES");
  else process.env.SANDBOX_CUSTOM_IMAGES = savedPolicy;
  if (savedMode === undefined) Reflect.deleteProperty(process.env, "SANDBOX_MODE");
  else process.env.SANDBOX_MODE = savedMode;
});

afterAll(async () => {
  await db.delete(sandboxes).where(inArray(sandboxes.ownerId, ids));
  await db.delete(conversationShares).where(inArray(conversationShares.userId, ids));
  await db.delete(conversations).where(eq(conversations.ownerId, owner));
  await db.delete(sandboxImages).where(inArray(sandboxImages.createdBy, ids));
  await db.delete(user).where(inArray(user.id, ids));
  await app.close();
});

function restart(as: string, id: string) {
  currentUser.id = as;
  return app.inject({ method: "POST", url: `/v1/conversations/${id}/sandbox/restart` });
}

function pending(id: string) {
  currentUser.id = owner;
  return app.inject({ method: "GET", url: `/v1/sandboxes?conversation_id=${id}` });
}

async function updatedAtOf(id: string): Promise<Date | undefined> {
  return (await db.query.conversations.findFirst({ where: eq(conversations.id, id), columns: { updatedAt: true } }))?.updatedAt;
}

describe("restarting a conversation's sandbox", () => {
  it("is the owner's alone: an editor of a shared conversation gets the same 404 as a stranger", async () => {
    const id = await conversation("agent");
    await db.insert(conversationShares).values({ conversationId: id, userId: editor, role: "editor", createdBy: owner });
    expect((await restart(editor, id)).statusCode).toBe(404);
    expect((await restart(`stranger-${randomUUID()}`, id)).statusCode).toBe(404);
  });

  it("refuses a chat and a folder on the user's own machine", async () => {
    expect((await restart(owner, await conversation("chat"))).statusCode).toBe(400);
    const local = { kind: "local", executorId: randomUUID(), executorName: "mac", path: "/x", isolation: "direct" } as Workspace;
    expect((await restart(owner, await conversation("agent", local))).statusCode).toBe(400);
  });

  it("has nothing to do for a conversation with no sandbox yet", async () => {
    const res = await restart(owner, await conversation("agent"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restarted: false });
  });

  it("refuses while anything runs on the conversation", async () => {
    const id = await conversation("agent");
    const claim = { streamId: `test-${randomUUID()}`, conversationId: id, userId: owner, abort: new AbortController(), approvals: new Map() };
    claimConversation(claim);
    try {
      const res = await restart(owner, id);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/^Stop the run first: the sandbox can't restart/);
    } finally {
      unregisterRun(claim.streamId);
    }
  });

  it("refuses while a sub-agent works in its sandbox, though the parent's run has ended", async () => {
    const id = await conversation("agent");
    const child = { streamId: `test-${randomUUID()}`, conversationId: randomUUID(), parentConversationId: id, userId: owner, abort: new AbortController(), approvals: new Map() };
    registerRun(child);
    try {
      const res = await restart(owner, id);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/sub-agents/);
    } finally {
      unregisterRun(child.streamId);
    }
  });

  it("shows the changes on the sandbox a restart would replace, not the newest row", async () => {
    const id = await conversation("agent");
    const values = { ownerId: owner, conversationId: id, provider: "container", image: "loxaic-sandbox:test", limits: { memory: 256, cpu: 1, network: false } };
    const [running] = await db.insert(sandboxes).values({ ...values, containerId: randomUUID(), status: "running", createdAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(sandboxes).values({ ...values, containerId: randomUUID(), status: "stopped" });
    const rows = (await pending(id)).json<{ id: string; pending_changes: unknown[] }[]>();
    expect(rows.map((row) => [row.id === running.id, row.pending_changes])).toEqual([
      [false, []],
      [true, [{ kind: "memory", fromMb: 256, toMb: 512 }]],
    ]);
  });

  describe.skipIf(!dockerReady)("with a real container", () => {

    it("makes it to today's settings, with the same files, and the old one goes", async () => {
      const id = await conversation("agent");
      try {
        const old = await getConversationSandbox(owner, id);
        await old.writeFile(`${old.workdir}/kept.txt`, "still here");
        // As one made when the default was smaller.
        await db.update(sandboxes).set({ limits: { memory: 256, cpu: 1, network: false } }).where(eq(sandboxes.containerId, old.ref));

        const before = (await pending(id)).json<{ pending_changes: unknown[] }[]>();
        expect(before[0].pending_changes).toEqual([{ kind: "memory", fromMb: 256, toMb: 512 }]);
        const touched = await updatedAtOf(id);

        const res = await restart(owner, id);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ restarted: true });
        // Nothing happened in the chat, so it keeps its place in the list.
        expect(await updatedAtOf(id)).toEqual(touched);

        const after = (await pending(id)).json<{ containerId: string; status: string; pending_changes: unknown[] }[]>();
        expect(after[0].containerId).not.toBe(old.ref);
        expect(after[0].status).toBe("running");
        expect(after[0].pending_changes).toEqual([]);
        const fresh = await getConversationSandbox(owner, id);
        expect(fresh.ref).toBe(after[0].containerId);
        expect(await fresh.readFile(`${fresh.workdir}/kept.txt`)).toBe("still here");
        expect(await old.exists()).toBe(false);
      } finally {
        await destroyConversationSandboxes(id);
      }
    }, 120_000);

    it("refuses on a server that no longer makes containers, and leaves the sandbox as it was", async () => {
      const id = await conversation("agent");
      try {
        const old = await getConversationSandbox(owner, id);
        process.env.SANDBOX_MODE = "off";
        const res = await restart(owner, id);
        expect(res.statusCode).toBe(409);
        expect(res.json<{ error: string }>().error).toMatch(/^The sandbox was not restarted: sandboxes are disabled/);
        expect(await old.exists()).toBe(true);
      } finally {
        process.env.SANDBOX_MODE = "container";
        await destroyConversationSandboxes(id);
      }
    }, 120_000);

    it("answers 429 with the numbers when today's size doesn't fit, and leaves the sandbox as it was", async () => {
      const id = await conversation("agent");
      try {
        const old = await getConversationSandbox(owner, id);
        await setAllocationOverride(owner, { memoryMb: 256 });
        const res = await restart(owner, id);
        expect(res.statusCode).toBe(429);
        expect(res.json<{ error: string; code: string }>()).toMatchObject({ code: "sandbox_allocation" });
        expect(res.json<{ error: string }>().error).toMatch(/^The sandbox was not restarted: /);
        expect(await old.exists()).toBe(true);
      } finally {
        await clearAllocationOverride(owner);
        await destroyConversationSandboxes(id);
      }
    }, 120_000);
  });
});

describe("changing a conversation's image", () => {
  it("moves a conversation with no sandbox yet, and back, telling every device watching", async () => {
    const image = await readyImage(owner, "Mine");
    const id = await conversation("agent");
    const seen: unknown[] = [];
    const unwatch = watchConversationEvents(id, (e) => seen.push(e));

    const moved = await post(owner, id, { id: image.id });
    expect(moved.statusCode).toBe(200);
    const expected = { kind: "scratch", image: { id: image.id, scope: "personal", reference: image.reference, label: "Mine" } };
    expect(await workspaceOf(id)).toEqual(expected);
    expect(seen).toEqual([{ type: "conversation.workspace", conversation_id: id, workspace: expected }]);

    // Back to Loxaic's own: a plain scratch workspace is stored as null.
    expect((await post(owner, id, null)).statusCode).toBe(200);
    expect(await workspaceOf(id)).toBeNull();
    unwatch();
  });

  it("never reads a body without the image key as a move back to Loxaic's own", async () => {
    const image = await readyImage(owner, "Mine");
    const workspace: Workspace = { kind: "scratch", image: { id: image.id, scope: "personal", reference: image.reference, label: "Mine" } };
    const id = await conversation("agent", workspace);
    currentUser.id = owner;
    for (const payload of [{}, { imageId: image.id }, "image"]) {
      const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/image`, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
      expect(res.statusCode).toBe(400);
    }
    expect(await workspaceOf(id)).toEqual(workspace);
  });

  it("is the owner's alone: an editor of a shared conversation gets the same 404 as a stranger", async () => {
    const image = await readyImage(null, "Shared");
    const id = await conversation("agent");
    await db.insert(conversationShares).values({ conversationId: id, userId: editor, role: "editor", createdBy: owner });
    expect((await post(editor, id, { id: image.id })).statusCode).toBe(404);
    expect((await post(`stranger-${randomUUID()}`, id, { id: image.id })).statusCode).toBe(404);
    expect(await workspaceOf(id)).toBeNull();
  });

  it("refuses someone else's image, a chat, and a folder on the user's own machine", async () => {
    const editorsOwn = await readyImage(editor, "Theirs");
    const agent = await conversation("agent");
    expect((await post(owner, agent, { id: editorsOwn.id })).statusCode).toBe(400);

    const shared = await readyImage(null, "Shared");
    expect((await post(owner, await conversation("chat"), { id: shared.id })).statusCode).toBe(400);
    const local = await conversation("agent", { kind: "local", executorId: "x", executorName: "Laptop", path: "/tmp", isolation: "direct" });
    expect((await post(owner, local, { id: shared.id })).statusCode).toBe(400);
  });

  it("refuses while anything runs on the conversation, and changes nothing", async () => {
    const image = await readyImage(null, "Shared");
    const id = await conversation("agent");
    const run = { streamId: `busy-${randomUUID()}`, conversationId: id, userId: owner, abort: new AbortController(), approvals: new Map() };
    claimConversation(run);
    try {
      const res = await post(owner, id, { id: image.id });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "conversation_busy" });
    } finally {
      unregisterRun(run.streamId);
    }
    expect(await workspaceOf(id)).toBeNull();
  });

  it("leaves the workspace and its sandbox as they were when the move fails", async () => {
    const image = await readyImage(null, "Shared");
    const id = await conversation("agent");
    // A sandbox that is not a container cannot be moved to an image.
    const [row] = await db
      .insert(sandboxes)
      .values({ ownerId: owner, conversationId: id, containerId: "/tmp/not-a-container", provider: "host", image: "host", status: "running" })
      .returning();
    const res = await post(owner, id, { id: image.id });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/not changed/);
    expect(await workspaceOf(id)).toBeNull();
    const after = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, row.id) });
    expect(after?.status).toBe("running");
  });

  it.skipIf(!dockerReady)("answers a move the owner's allocation refuses with a 429 and the numbers (#254)", async () => {
    const image = await readyImage(null, "Shared");
    const id = await conversation("agent");
    try {
      await getConversationSandbox(owner, id);
      // Smaller than one default sandbox: the new container cannot fit.
      await setAllocationOverride(owner, { memoryMb: 256 });
      const res = await post(owner, id, { id: image.id });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({
        code: "sandbox_allocation",
        reason: "too_big",
        allocation: { memoryMb: 256 },
        error: expect.stringMatching(/^The image was not changed: /) as unknown,
      });
      expect(await workspaceOf(id)).toBeNull();
      const row = await db.query.sandboxes.findFirst({ where: eq(sandboxes.conversationId, id) });
      expect(row?.status).toBe("running");
    } finally {
      await clearAllocationOverride(owner);
      await destroyConversationSandboxes(id);
    }
  }, 120_000);
});
