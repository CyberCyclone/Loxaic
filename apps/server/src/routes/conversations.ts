import type { FastifyInstance } from "fastify";
import { eq, and, isNull, desc, inArray, or } from "@loxaic/db";
import { db } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords } from "@loxaic/db/schema";
import type { ContextBreakdown } from "@loxaic/types";
import { authenticate } from "../auth/middleware";
import { detectForks } from "@loxaic/sync";
import { destroyConversationSandboxes } from "../agent/sandbox-manager.ts";
import { atLeast, type ConversationRole, resolveAccess } from "../streams/authz";

/**
 * Does this user hold at least `minimum` on this conversation?
 *
 * The REST counterpart of the WS chokepoint. It exists because the same
 * ownership predicate was inlined into five conversation routes and seven
 * sandbox ones — twelve places that all had to learn about sharing at once,
 * and twelve chances to miss one. Routes now ask this instead.
 *
 * Returns a boolean rather than throwing: every caller answers a refusal with
 * the same 404 the resource-not-found path uses, so there is no existence
 * oracle to leak.
 */
async function hasRole(
  userId: string,
  conversationId: string,
  minimum: ConversationRole,
): Promise<boolean> {
  const grant = await resolveAccess(userId, conversationId);
  return !!grant && atLeast(grant.role, minimum);
}

export function conversationRoutes(app: FastifyInstance) {
  /**
   * Conversations this user can see: their own, plus any shared with them.
   *
   * Each row carries the caller's `role`, because the sidebar has to render a
   * shared thread differently (a badge, and a read-only composer for a
   * viewer) and would otherwise have to ask per conversation.
   */
  app.get("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const shared = await db
      .select({ conversationId: conversationShares.conversationId, role: conversationShares.role })
      .from(conversationShares)
      .where(eq(conversationShares.userId, userId));
    const sharedRoles = new Map(shared.map((s) => [s.conversationId, s.role]));

    const rows = await db
      .select()
      .from(conversations)
      .where(
        and(
          isNull(conversations.deletedAt),
          shared.length
            ? or(eq(conversations.ownerId, userId), inArray(conversations.id, [...sharedRoles.keys()]))
            : eq(conversations.ownerId, userId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(50);

    return rows.map((row) => ({
      ...row,
      role: row.ownerId === userId ? "owner" : (sharedRoles.get(row.id) ?? "viewer"),
    }));
  });

  // Get single conversation
  app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const grant = await resolveAccess(userId, request.params.id);
    if (!grant) {
      reply.code(404);
      return { error: "Not found" };
    }
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, request.params.id),
    });
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return { ...row, role: grant.role };
  });

  // Create conversation
  app.post("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { title } = request.body as { title?: string };
    const [row] = await db
      .insert(conversations)
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty title must still fall back to the default; ?? would store "".
      .values({ ownerId: userId, title: title || "New conversation" })
      .returning();
    return row;
  });

  // Update conversation (per-conversation model preference / MCP overrides)
  app.patch<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { model_pref, mcp_overrides } = request.body as {
      model_pref?: { model?: string };
      mcp_overrides?: { disabledServerIds?: string[] };
    };
    const mcpOverrides =
      mcp_overrides !== undefined
        ? {
            disabledServerIds: Array.isArray(mcp_overrides.disabledServerIds)
              ? mcp_overrides.disabledServerIds.map(String)
              : [],
          }
        : undefined;
    // Drizzle's `.returning()` type doesn't reflect that a non-matching
    // WHERE yields zero rows — cast to what actually comes back at runtime.
    // Owner-only: model and MCP preferences reconfigure the conversation for
    // everyone in it, which is not something a guest editor should do.
    if (!(await hasRole(userId, request.params.id, "owner"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    const [row] = (await db
      .update(conversations)
      .set({
        ...(model_pref !== undefined ? { modelPref: model_pref } : {}),
        ...(mcpOverrides !== undefined ? { mcpOverrides } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, request.params.id))
      .returning()) as (typeof conversations.$inferSelect | undefined)[];
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return row;
  });

  // Delete conversation (soft)
  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    // Owner-only, and silent either way: a non-owner's delete must look the
    // same as deleting something that was already gone.
    if (await hasRole(userId, request.params.id, "owner")) {
      await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(eq(conversations.id, request.params.id));
      // The conversation row is only soft-deleted, but its sandbox is not
      // soft-anything: sandboxes now persist across idle periods rather than
      // being cleaned up by a 30-minute timer, so without this a deleted
      // conversation would leave a container holding its files running on the
      // host with nothing left that could ever reach it — the user cannot
      // open the conversation, and the abandoned reaper would take weeks.
      // Deliberately not awaited into the response: reclaiming disk is not
      // something the user's delete should wait on, or fail on.
      void destroyConversationSandboxes(request.params.id).catch((err: unknown) => {
        request.log.warn(
          { err, conversationId: request.params.id },
          "failed to destroy sandboxes for a deleted conversation",
        );
      });
    }
    return { ok: true };
  });

  // Get messages for conversation
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/messages", async (request, reply) => {
    const userId = await authenticate(request, reply);
    // Viewer is enough: reading the thread is the whole point of a share.
    if (!(await hasRole(userId, request.params.id, "viewer"))) {
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
              reusableTokens: u.reusableTokens,
              outputTokens: u.outputTokens,
              ttftMs: u.ttftMs,
              promptMs: u.promptMs,
              predictMs: u.predictMs,
              totalMs: u.totalMs,
              promptTps: u.promptTps,
              predictedTps: u.predictedTps,
              contextBreakdown: (u.contextBreakdown as ContextBreakdown | null) ?? null,
            }
          : null,
      };
    });

    const msgs = rows.map((m) => ({ id: m.id, parent_id: m.parentId, deleted_at: m.deletedAt?.toISOString() ?? null }));
    const forks = detectForks(msgs);
    return { messages: rowsWithUsage, forks };
  });
}