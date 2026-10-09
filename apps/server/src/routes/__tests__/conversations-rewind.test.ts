import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";

/**
 * The rewind routes' answers: what a rewind returns, and how each refusal
 * reads — not found (the same for "not yours"), busy, and a message that
 * cannot be rewound to. Only authentication is stubbed; the admin transcript
 * shows what an audit-retaining rewind kept, marked.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { adminConversationRoutes } = await import("../shares.ts");
const { claimConversation, unregisterRun } = await import("../../streams/registry.ts");
const { initStreamBroker } = await import("../../streams/index.ts");

describe("POST /v1/conversations/:id/rewind", () => {
  const owner = `test-rewind-routes-${uuid()}`;
  const viewer = `test-rewind-routes-viewer-${uuid()}`;
  const app = Fastify();
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    conversationRoutes(app);
    adminConversationRoutes(app);
    await app.ready();
    for (const id of [owner, viewer]) {
      await db.insert(user).values({
        id, name: "Rewind Routes", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversationShares).where(inArray(conversationShares.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
    await db.delete(user).where(inArray(user.id, [owner, viewer]));
    await app.close();
  });

  let clock = Date.now() - 10_000;
  async function thread(): Promise<{ convId: string; ids: string[] }> {
    const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "routes" }).returning();
    convIds.push(conv.id);
    await db.insert(conversationShares).values({ conversationId: conv.id, userId: viewer, role: "viewer", createdBy: owner });
    const ids: string[] = [];
    for (const [authorType, text] of [["user", "one"], ["assistant", "reply one"], ["user", "two"], ["assistant", "reply two"]] as const) {
      clock += 10;
      const id = uuid();
      ids.push(id);
      await db.insert(messages).values({
        id, conversationId: conv.id, authorType, authorUserId: authorType === "user" ? owner : null, origin: "server",
        lamport: clock, content: [{ kind: "text", text }] as ContentBlock[], status: "complete", createdAt: new Date(clock),
      });
    }
    return { convId: conv.id, ids };
  }

  const post = (convId: string, body: unknown) =>
    app.inject({ method: "POST", url: `/v1/conversations/${convId}/rewind`, payload: body as object });

  it("rewinds and returns the text, after previewing what would go", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    currentUser.id = owner;
    const { convId, ids } = await thread();
    const preview = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/rewind/${ids[2]}` });
    expect(preview.json()).toEqual({ turns: 1, others: 0, retained: false, files: 0 });

    const res = await post(convId, { message_id: ids[2] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: "two",
      attachments: [],
      attachments_withheld: false,
      removed_ids: [ids[2], ids[3]],
      // Nothing was edited, so nothing to put back.
      files: { restored: [], skipped: [] },
    });
    const page = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages` });
    expect(page.json<{ messages: { id: string }[] }>().messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
  });

  it("answers each refusal as itself", async () => {
    currentUser.id = owner;
    const { convId, ids } = await thread();
    expect((await post(convId, {})).statusCode).toBe(400);
    expect((await post(convId, { message_id: ids[2], scope: "everything" })).statusCode).toBe(400);
    expect((await post(convId, { message_id: ids[1] })).json()).toMatchObject({ code: "not_rewindable" });
    expect((await post(convId, { message_id: uuid() })).statusCode).toBe(404);

    const busy = { streamId: uuid(), conversationId: convId, userId: owner, abort: new AbortController(), approvals: new Map() };
    claimConversation(busy);
    try {
      const res = await post(convId, { message_id: ids[2] });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "conversation_busy" });
    } finally {
      unregisterRun(busy.streamId);
    }

    // A viewer is answered exactly as a stranger: not found.
    currentUser.id = viewer;
    const asViewer = await post(convId, { message_id: ids[2] });
    expect(asViewer.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${convId}/rewind/${ids[2]}` })).statusCode).toBe(404);
    expect((await db.select().from(messages).where(eq(messages.conversationId, convId)))).toHaveLength(4);
  });

  it("with audit retention, the admin transcript shows the rewound rows, marked", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "true";
    currentUser.id = owner;
    const { convId, ids } = await thread();
    await post(convId, { message_id: ids[2] });

    currentUser.id = owner; // requireAdmin is stubbed through
    const res = await app.inject({ method: "GET", url: `/v1/admin/conversations/${convId}/messages` });
    const rows = res.json<{ messages: { id: string; removedAt: string | null }[] }>().messages;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.removedAt !== null)).toEqual([false, false, true, true]);
  });
});
