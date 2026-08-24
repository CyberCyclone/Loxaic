import type { FastifyInstance } from "fastify";
import { eq, and, isNull, desc } from "@shannon/db";
import { db } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import { detectForks } from "@shannon/sync";

export async function conversationRoutes(app: FastifyInstance) {
  // List conversations
  app.get("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const rows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.ownerId, userId), isNull(conversations.deletedAt)))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    return rows;
  });

  // Get single conversation
  app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const row = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, request.params.id), eq(conversations.ownerId, userId)),
    });
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return row;
  });

  // Create conversation
  app.post("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { title } = request.body as { title?: string };
    const [row] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: title || "New conversation" })
      .returning();
    return row;
  });

  // Update conversation (currently: per-conversation model preference)
  app.patch<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { model_pref } = request.body as { model_pref?: { model?: string } };
    const [row] = await db
      .update(conversations)
      .set({
        ...(model_pref !== undefined ? { modelPref: model_pref } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, request.params.id), eq(conversations.ownerId, userId)))
      .returning();
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return row;
  });

  // Delete conversation (soft)
  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(and(eq(conversations.id, request.params.id), eq(conversations.ownerId, userId)));
    return { ok: true };
  });

  // Get messages for conversation
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/messages", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, request.params.id), eq(conversations.ownerId, userId)),
    });
    if (!conv) {
      reply.code(404);
      return { error: "Not found" };
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, request.params.id), isNull(messages.deletedAt)))
      .orderBy(messages.createdAt)
      .limit(200);

    // No relation is declared between messages and usageRecords (messageId
    // carries no FK constraint), so join them by hand: one query for the
    // whole thread's usage rows, keyed by messageId for an O(1) attach below.
    const usageRows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.conversationId, request.params.id));
    const usageByMessageId = new Map(usageRows.filter((u) => u.messageId).map((u) => [u.messageId, u]));

    const rowsWithUsage = rows.map((m) => {
      const u = usageByMessageId.get(m.id);
      return {
        ...m,
        usage: u
          ? {
              inputTokens: u.inputTokens,
              cachedTokens: u.cachedTokens,
              outputTokens: u.outputTokens,
              ttftMs: u.ttftMs,
              promptMs: u.promptMs,
              predictMs: u.predictMs,
              totalMs: u.totalMs,
              promptTps: u.promptTps,
              predictedTps: u.predictedTps,
            }
          : null,
      };
    });

    const msgs = rows.map((m) => ({ id: m.id, parent_id: m.parentId, deleted_at: m.deletedAt?.toISOString() ?? null }));
    const forks = detectForks(msgs);
    return { messages: rowsWithUsage, forks };
  });
}