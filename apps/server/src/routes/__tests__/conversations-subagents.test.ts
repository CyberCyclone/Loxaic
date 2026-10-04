import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { SubAgentInfo, SubAgentLive } from "@loxaic/types";

/**
 * A sub-agent's conversation through the REST routes.
 *
 * It is a real row owned by its parent's owner, so every query that lists
 * conversations by owner would show it as a thread of its own unless told not
 * to; and every route that checks a role would let its owner act in it unless
 * the role it grants is capped. Both are asserted here against the routes
 * themselves — only authentication is stubbed.
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

const { conversationRoutes } = await import("../conversations.ts");
const { adminConversationRoutes, shareRoutes } = await import("../shares.ts");
const { statsRoutes } = await import("../stats.ts");

describe("a sub-agent's conversation over REST", () => {
  const owner = `test-subroutes-owner-${uuid()}`;
  const viewer = `test-subroutes-viewer-${uuid()}`;
  const stranger = `test-subroutes-stranger-${uuid()}`;
  const admin = `admin-test-subroutes-${uuid()}`;
  const everyone = [owner, viewer, stranger, admin];
  const app = Fastify();
  let parentId = "";
  let childId = "";
  const childStream = uuid();
  const childMessage = uuid();

  const as = (id: string) => {
    currentUser.id = id;
  };

  beforeAll(async () => {
    conversationRoutes(app);
    shareRoutes(app);
    adminConversationRoutes(app);
    statsRoutes(app);
    await app.ready();
    for (const id of everyone) {
      await db.insert(user).values({
        id,
        name: "Test Sub-agent Routes",
        email: `${id}@example.test`,
        emailVerified: true,
        ...(id.startsWith("admin") ? { role: "admin" } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const [parent] = await db.insert(conversations).values({ ownerId: owner, title: "Parent thread", kind: "agent" }).returning();
    parentId = parent.id;
    const info: SubAgentInfo = {
      description: "Read the docs",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      streamId: childStream,
      status: "complete",
      startedAt: Date.now() - 5_000,
      endedAt: Date.now() - 1_000,
    };
    const [child] = await db
      .insert(conversations)
      .values({
        ownerId: owner,
        title: "Read the docs",
        kind: "subagent",
        parentConversationId: parentId,
        parentMessageId: uuid(),
        parentCallId: "call_0",
        subagent: info,
      })
      .returning();
    childId = child.id;
    await db.insert(messages).values([
      { id: uuid(), conversationId: childId, authorType: "user", origin: "server", lamport: 1, content: [{ kind: "text", text: "the task" }], status: "complete" },
      { id: childMessage, conversationId: childId, authorType: "assistant", origin: "server", lamport: 2, content: [{ kind: "text", text: "the report" }], status: "complete" },
    ]);
    await db.insert(usageRecords).values([
      { id: uuid(), userId: owner, conversationId: parentId, model: "llama-3.1-8b-instruct", inputTokens: 100, outputTokens: 10 },
      {
        id: uuid(),
        userId: owner,
        conversationId: childId,
        messageId: childMessage,
        runId: childStream,
        model: "llama-3.1-8b-instruct",
        inputTokens: 700,
        outputTokens: 70,
        predictedTps: 42,
        contextBreakdown: { used_tokens: 770, window_tokens: 8192, parts: [] },
      },
    ]);
    await db.insert(conversationShares).values({ conversationId: parentId, userId: viewer, role: "viewer", createdBy: owner });
  });

  afterAll(async () => {
    await db.delete(usageRecords).where(inArray(usageRecords.userId, everyone));
    await db.delete(messages).where(eq(messages.conversationId, childId));
    await db.delete(conversations).where(inArray(conversations.id, [childId, parentId]));
    for (const id of everyone) await db.delete(user).where(eq(user.id, id));
    await app.close();
  });

  it("is not listed as a thread of its own, for its owner or an admin", async () => {
    as(owner);
    const mine = (await app.inject({ method: "GET", url: "/v1/conversations" })).json<{ id: string }[]>();
    expect(mine.map((c) => c.id)).toContain(parentId);
    expect(mine.map((c) => c.id)).not.toContain(childId);
    as(admin);
    const all = (await app.inject({ method: "GET", url: "/v1/admin/conversations" })).json<{ id: string }[]>();
    expect(all.map((c) => c.id)).not.toContain(childId);
  });

  it("is listed by its parent, to whoever can see the parent, with what it measured", async () => {
    for (const id of [owner, viewer]) {
      as(id);
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${parentId}/subagents` });
      expect(res.statusCode).toBe(200);
      const [row] = res.json<{ subagents: SubAgentLive[] }>().subagents;
      expect(row).toMatchObject({
        conversation_id: childId,
        stream_id: childStream,
        call_id: "call_0",
        description: "Read the docs",
        status: "complete",
        context_used: 770,
        window_tokens: 8192,
        last_gen_tps: 42,
        // Not reported by that request: null, never 0.
        last_prompt_tps: null,
        tokens_out: 70,
      });
    }
    as(stranger);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${parentId}/subagents` })).statusCode).toBe(404);
    // A child has no children: its id is not a thread's.
    as(owner);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${childId}/subagents` })).statusCode).toBe(404);
  });

  it("can be read by whoever can read the parent, and by nobody else", async () => {
    for (const id of [owner, viewer]) {
      as(id);
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${childId}/messages` });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).toContain("the report");
    }
    as(stranger);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${childId}/messages` })).statusCode).toBe(404);
  });

  it("cannot be renamed, deleted or shared — not even by its owner", async () => {
    as(owner);
    const patch = await app.inject({ method: "PATCH", url: `/v1/conversations/${childId}`, payload: { title: "mine now" } });
    expect(patch.statusCode).toBe(404);
    // DELETE answers the same `ok` to everyone by design; what matters is
    // that the row is still there afterwards.
    await app.inject({ method: "DELETE", url: `/v1/conversations/${childId}` });
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, childId) });
    expect(row?.title).toBe("Read the docs");
    expect(row?.deletedAt).toBeNull();
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${childId}/shares` })).statusCode).toBe(404);
    const share = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${childId}/shares`,
      payload: { user_id: stranger, role: "editor" },
    });
    expect(share.statusCode).toBe(404);
    as(admin);
    const adminShare = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${childId}/shares`,
      payload: { user_id: stranger, role: "editor" },
    });
    expect(adminShare.statusCode).toBe(404);
    for (const action of ["restore", "purge"]) {
      expect((await app.inject({ method: "POST", url: `/v1/admin/conversations/${childId}/${action}` })).statusCode).toBe(404);
    }
    expect((await db.query.conversations.findFirst({ where: eq(conversations.id, childId) }))?.id).toBe(childId);
  });

  it("counts its usage under the thread that spawned it", async () => {
    as(owner);
    const recent = (await app.inject({ method: "GET", url: "/v1/stats/conversations?range=today" })).json<
      { conversationId: string; title: string; tokens: number }[]
    >();
    // One row, the parent's, carrying both conversations' tokens — and none
    // for the child, whose title nobody chose and whose id opens nothing.
    expect(recent.map((r) => r.conversationId)).not.toContain(childId);
    expect(recent.find((r) => r.conversationId === parentId)).toMatchObject({ title: "Parent thread", tokens: 880 });

    const usage = (await app.inject({ method: "GET", url: `/v1/stats/usage?conversation_id=${parentId}&range=today` })).json<{
      inputTokens: number;
      outputTokens: number;
      requestCount: number;
    }>();
    // "What did this thread cost" includes what its sub-agents cost.
    expect(usage).toMatchObject({ inputTokens: 800, outputTokens: 80, requestCount: 2 });
  });
});
