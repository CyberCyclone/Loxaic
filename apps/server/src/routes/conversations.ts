import type { FastifyInstance } from "fastify";
import { eq, ne, and, isNull, desc, inArray, or, getTableColumns } from "@loxaic/db";
import { db } from "@loxaic/db";
import { conversationShares, conversations, usageRecords } from "@loxaic/db/schema";
import { normalizeMcpOverrides, type ContextBreakdown } from "@loxaic/types";
import { authenticate } from "../auth/middleware";
import { detectForks } from "@loxaic/sync";
import { deleteConversation } from "../conversations/delete.ts";
import { previewRewind, rewindConversation, RewindError } from "../conversations/rewind.ts";
import { ConversationBusyError } from "../streams/registry.ts";
import { NotFoundError } from "../streams/authz.ts";
import { BadCursorError, loadMessagePage, type MessagePage } from "../conversations/history-page.ts";

/** Rows per page of a thread's history — a floor, since a page grows back to
 * the start of the turn it cuts into. */
const MESSAGE_PAGE_SIZE = 200;
import { parseWorkspaceInput, WorkspaceError } from "../agent/workspace.ts";
import { INSTRUCTIONS_SUMMARY_COLUMN, summarizeInstructions } from "../agent/instructions.ts";

/**
 * A conversation row as a client may see it. The stored instructions
 * snapshot is the project's whole AGENTS.md — up to a megabyte, fifty times
 * over in a listing — so it leaves as a summary: which file, how big, and how
 * the model is shown it.
 */
function publicConversation<T extends { instructions: unknown }>(row: T): Omit<T, "instructions"> & {
  instructions: ReturnType<typeof summarizeInstructions>;
} {
  const { instructions, ...rest } = row;
  return { ...rest, instructions: summarizeInstructions(instructions) };
}
import { getRun, getRunByConversation } from "../streams/registry.ts";
import { listSubagents } from "../streams/runs/subagentRun.ts";
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
   *
   * Sub-agent conversations are excluded for the same reason and a stronger
   * one: they are owned by their parent's owner, so every one would otherwise
   * appear here as a thread of its own. They are listed by their parent
   * (`GET /v1/conversations/:id/subagents`).
   */
  app.get("/v1/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const shared = await db
      .select({ conversationId: conversationShares.conversationId, role: conversationShares.role })
      .from(conversationShares)
      .where(eq(conversationShares.userId, userId));
    const sharedRoles = new Map(shared.map((s) => [s.conversationId, s.role]));

    // Every column but the instructions text: a snapshot can be a megabyte,
    // this is fifty rows, and the listing only ever sends a summary of it.
    const rows = await db
      .select({ ...getTableColumns(conversations), instructions: INSTRUCTIONS_SUMMARY_COLUMN })
      .from(conversations)
      .where(
        and(
          isNull(conversations.deletedAt),
          ne(conversations.kind, "routine"),
          ne(conversations.kind, "subagent"),
          shared.length
            ? or(eq(conversations.ownerId, userId), inArray(conversations.id, [...sharedRoles.keys()]))
            : eq(conversations.ownerId, userId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(50);

    return rows.map((row) => ({
      ...publicConversation(row),
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
    // The summary, not the snapshot, as the listing does: this is read per
    // opened thread and again at the end of every run, and a snapshot can be
    // a megabyte that publicConversation would only throw away.
    const row = (
      await db
        .select({ ...getTableColumns(conversations), instructions: INSTRUCTIONS_SUMMARY_COLUMN })
        .from(conversations)
        .where(eq(conversations.id, request.params.id))
        .limit(1)
    ).at(0);
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    // Whether a run is going right now, from the registry — exact, and the
    // signal a test (or a client) polls for "has the agent finished" rather
    // than guessing from message statuses. Process-local, like the registry.
    return { ...publicConversation(row), role: grant.role, active_run: getRunByConversation(row.id) !== undefined };
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
    const { title, kind, workspace, mcp_overrides } = (request.body ?? {}) as {
      title?: string;
      kind?: unknown;
      workspace?: unknown;
      /** MCP choices made before the conversation existed — the agent's
       * create-then-send path, when a workspace was chosen. */
      mcp_overrides?: unknown;
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
        mcpOverrides: normalizeMcpOverrides(mcp_overrides),
      })
      .returning();
    return publicConversation(row);
  });

  // Update conversation (per-conversation model preference / MCP overrides)
  app.patch<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { model_pref, mcp_overrides } = request.body as {
      model_pref?: { model?: string };
      mcp_overrides?: unknown;
    };
    // Anything that is not an object clears both lists, as a malformed body
    // always has; a server named in both lists is kept only as disabled.
    const mcpOverrides =
      mcp_overrides !== undefined
        ? (normalizeMcpOverrides(mcp_overrides) ?? { disabledServerIds: [], enabledServerIds: [] })
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
      // The summary, not the snapshot — see the GET above.
      .returning({ ...getTableColumns(conversations), instructions: INSTRUCTIONS_SUMMARY_COLUMN })) as (
      | typeof conversations.$inferSelect
      | undefined
    )[];
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return publicConversation(row);
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

  /**
   * Rewinds a conversation to one of its messages (#166): that message and
   * everything after it are removed, and its text (with its attachments, for
   * the person who sent them) comes back to go in the composer. Editors only,
   * and 409 while a run is going. What "removed" means follows the deleted-
   * conversation retention setting — see conversations/rewind.ts.
   */
  app.post<{ Params: { id: string }; Body: { message_id?: unknown } | undefined }>(
    "/v1/conversations/:id/rewind",
    async (request, reply) => {
      const userId = await authenticate(request, reply);
      const messageId = request.body?.message_id;
      if (typeof messageId !== "string" || !UUID_RE.test(messageId)) {
        reply.code(400);
        return { error: "message_id is required" };
      }
      try {
        const result = await rewindConversation({ userId, conversationId: request.params.id, messageId });
        return {
          text: result.text,
          attachments: result.attachments,
          attachments_withheld: result.attachmentsWithheld,
          removed_ids: result.removedIds,
        };
      } catch (err) {
        return rewindFailure(err, reply);
      }
    },
  );

  /** What a rewind to `messageId` would remove, for its confirm dialog. */
  app.get<{ Params: { id: string; messageId: string } }>(
    "/v1/conversations/:id/rewind/:messageId",
    async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!UUID_RE.test(request.params.messageId)) {
        reply.code(404);
        return { error: "Not found" };
      }
      try {
        const preview = await previewRewind({ userId, conversationId: request.params.id, messageId: request.params.messageId });
        return { turns: preview.turns, others: preview.others, retained: preview.retained };
      } catch (err) {
        return rewindFailure(err, reply);
      }
    },
  );

  /**
   * The sub-agents this conversation's runs have spawned, newest first.
   *
   * What the thread's cards and its Sub-agents list are drawn from after a
   * reload, or once the stream log that carried them live has expired. Viewer
   * is enough, as for reading the thread: a child's transcript is part of what
   * the thread did. Each row carries the child's conversation id, whose
   * messages are read through the ordinary messages route.
   *
   * `running` is the registry's word, not the row's: a child the row still
   * calls running but no run is driving is reported as lost.
   */
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/subagents", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const grant = await resolveAccess(userId, request.params.id);
    // A sub-agent has no sub-agents of its own, and answering `[]` for one
    // would say its id is a thread's.
    if (!grant || grant.kind === "subagent") {
      reply.code(404);
      return { error: "Not found" };
    }
    // `server_now` is what lets a device time a child that is still running
    // from its real start: `started_at` is on this clock, not the device's.
    return {
      subagents: await listSubagents(request.params.id, (streamId) => getRun(streamId) !== undefined),
      server_now: Date.now(),
    };
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
              draftTokens: u.draftTokens,
              draftAcceptedTokens: u.draftAcceptedTokens,
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rewind's refusal as a response: not found (the same for "not yours"),
 * busy, or a message that cannot be rewound to. Anything else is a fault. */
function rewindFailure(err: unknown, reply: { code(n: number): unknown }): { error: string; code?: string } {
  if (err instanceof NotFoundError) {
    reply.code(404);
    return { error: "Not found" };
  }
  if (err instanceof ConversationBusyError) {
    reply.code(409);
    return { error: "Stop the reply in progress first.", code: err.code };
  }
  if (err instanceof RewindError) {
    reply.code(400);
    return { error: err.message, code: err.code };
  }
  throw err;
}
