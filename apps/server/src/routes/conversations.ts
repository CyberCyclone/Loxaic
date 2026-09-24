import type { FastifyInstance } from "fastify";
import { eq, ne, and, isNull, desc, inArray, or } from "@loxaic/db";
import { db } from "@loxaic/db";
import { conversationShares, conversations, usageRecords } from "@loxaic/db/schema";
import type { ContextBreakdown } from "@loxaic/types";
import { authenticate } from "../auth/middleware";
import { detectForks } from "@loxaic/sync";
import { deleteConversation } from "../conversations/delete.ts";
import { BadCursorError, loadMessagePage, type MessagePage } from "../conversations/history-page.ts";

/** Rows per page of a thread's history — a floor, since a page grows back to
 * the start of the turn it cuts into. */
const MESSAGE_PAGE_SIZE = 200;
import { parseWorkspaceInput, WorkspaceError } from "../agent/workspace.ts";
import { getRunByConversation } from "../streams/registry.ts";
import { hasRole, resolveAccess } from "../streams/authz";

export function conversationRoutes(app: FastifyInstance) {
  /**
   * Conversations this user can see: their own, plus any shared with them.
   *
   * Each row carries the caller's `role`, because the sidebar has to render a
   * shared thread differently (a badge, and a read-only composer for a
   * viewer) and would otherwise have to ask per conversation.
   *
   * Routine chats are excluded. They are listed only by the routine that
   * produced them (`GET /v1/routines/:id/conversations`), and both surface
   * hooks have always dropped them client-side — but this query is capped at
   * 50 rows, and an hourly routine now makes 24 real conversations a day, so
   * leaving them in would push a user's actual chats out of their own list.
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
          ne(conversations.kind, "routine"),
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
    // Whether a run is going right now, from the registry — exact, and the
    // signal a test (or a client) polls for "has the agent finished" rather
    // than guessing from message statuses. Process-local, like the registry.
    return { ...row, role: grant.role, active_run: getRunByConversation(row.id) !== undefined };
  });

  /**
   * Create a conversation.
   *
   * An agent conversation may carry a `workspace` — where its files live —
   * which is fixed here and never patched, because the agent's system prompt
   * is built from it (see agent/workspace.ts). Chat conversations have no
   * workspace; sending one is a 400 rather than a silent drop, since a client
   * that asked for a repo and got a scratch directory would only find out
   * three tool calls later.
   */
  app.post("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { title, kind, workspace } = (request.body ?? {}) as {
      title?: string;
      kind?: unknown;
      workspace?: unknown;
    };
    // Only the two kinds a client may open. Routines create their own rows
    // server-side and are not something a client creates by name.
    if (kind !== undefined && kind !== "chat" && kind !== "agent") {
      reply.code(400);
      return { error: "kind must be chat or agent" };
    }
    const resolvedKind = kind ?? "chat";
    if (workspace !== undefined && workspace !== null && resolvedKind !== "agent") {
      reply.code(400);
      return { error: "only agent conversations have a workspace" };
    }
    let parsed;
    try {
      parsed = resolvedKind === "agent" ? await parseWorkspaceInput(workspace, { userId }) : null;
    } catch (err) {
      if (err instanceof WorkspaceError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
    const [row] = await db
      .insert(conversations)
      .values({
        ownerId: userId,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty title must still fall back to the default; ?? would store "".
        title: title || "New conversation",
        kind: resolvedKind,
        // Scratch is stored as null, the same value every pre-workspace row
        // has, so the two are indistinguishable everywhere they are read.
        workspace: parsed && parsed.kind !== "scratch" ? parsed : null,
      })
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

  /**
   * Delete a conversation.
   *
   * What that does to the data is the deployment's decision, not this route's
   * — `deleteConversation` erases it outright, or keeps it for an admin to
   * audit, according to the retention setting (see conversations/delete.ts).
   * Either way it is gone for the user and everyone it was shared with.
   *
   * Owner-only, and silent either way: a non-owner's delete must look the same
   * as deleting something that was already gone. An admin resolves to viewer
   * (streams/authz.ts), so this refuses them too — seeing every conversation
   * is not the same as being able to delete one.
   */
  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (await hasRole(userId, request.params.id, "owner")) {
      await deleteConversation(request.params.id, request.log);
    }
    return { ok: true };
  });

  // Get messages for conversation
  // The newest page, or the page older than `?before=` — see
  // conversations/history-page.ts for where pages are cut and why (#213).
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/v1/conversations/:id/messages", async (request, reply) => {
    const userId = await authenticate(request, reply);
    // Viewer is enough: reading the thread is the whole point of a share.
    if (!(await hasRole(userId, request.params.id, "viewer"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    let page: MessagePage;
    try {
      page = await loadMessagePage(request.params.id, { limit: MESSAGE_PAGE_SIZE, before: request.query.before });
    } catch (err) {
      if (!(err instanceof BadCursorError)) throw err;
      reply.code(400);
      return { error: "Unknown cursor" };
    }
    const { rows } = page;

    // No relation is declared between messages and usageRecords (messageId
    // carries no FK constraint), so join them by hand: one query for this
    // page's usage rows, keyed by messageId for an O(1) attach below.
    const usageRows = rows.length
      ? await db
          .select()
          .from(usageRecords)
          .where(
            and(
              eq(usageRecords.conversationId, request.params.id),
              inArray(usageRecords.messageId, rows.map((m) => m.id)),
            ),
          )
      : [];
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
    return { messages: rowsWithUsage, forks, hasMore: page.hasMore, before: page.before };
  });
}