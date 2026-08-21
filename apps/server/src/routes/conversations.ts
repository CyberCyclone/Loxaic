import type { FastifyInstance } from "fastify";
import { eq, and, isNull, desc } from "@shannon/db";
import { db } from "@shannon/db";
import { conversations, messages } from "@shannon/db/schema";
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
    const msgs = rows.map((m) => ({ id: m.id, parent_id: m.parentId, deleted_at: m.deletedAt?.toISOString() ?? null }));
    const forks = detectForks(msgs);
    return { messages: rows, forks };
  });
}