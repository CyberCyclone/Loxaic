import type { FastifyInstance } from "fastify";
import { and, db, desc, eq, ilike, isNotNull, isNull, ne, or } from "@loxaic/db";
import { conversationShares, conversations, messages, user } from "@loxaic/db/schema";
import { authenticate, requireAdmin } from "../auth/middleware";
import { purgeConversation, restoreConversation } from "../conversations/delete.ts";
import { conversationPurgeAt } from "../settings.ts";
import { resolveAccess } from "../streams/authz";

/**
 * Whether this conversation is one the audit routes may act on.
 *
 * Every one of them is about a *deleted* conversation, and each answers 404
 * otherwise — an admin restoring, holding or erasing a live conversation is
 * not something this feature does, and an "ok" would say it had happened.
 */
async function isRetained(id: string): Promise<boolean> {
  const row = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), isNotNull(conversations.deletedAt)),
    columns: { id: true },
  });
  return row !== undefined;
}

/** Roles a share may grant. `owner` is deliberately absent — ownership moves
 * through a separate, admin-only action, not by handing out a role. */
const SHARE_ROLES = ["viewer", "editor"] as const;
type ShareRole = (typeof SHARE_ROLES)[number];

function isShareRole(value: unknown): value is ShareRole {
  return typeof value === "string" && (SHARE_ROLES as readonly string[]).includes(value);
}

/** Shares on a conversation, with the display details a share sheet needs. */
async function listShares(conversationId: string) {
  return db
    .select({
      userId: conversationShares.userId,
      role: conversationShares.role,
      createdAt: conversationShares.createdAt,
      createdBy: conversationShares.createdBy,
      name: user.name,
      email: user.email,
    })
    .from(conversationShares)
    .innerJoin(user, eq(user.id, conversationShares.userId))
    .where(eq(conversationShares.conversationId, conversationId));
}

export function shareRoutes(app: FastifyInstance) {
  /**
   * Who a conversation is shared with. Owner-only, like the mutations below:
   * the guest list is the owner's business, and a viewer learning who else
   * has access is a disclosure they were never granted.
   */
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/shares", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const grant = await resolveAccess(userId, request.params.id);
    if (grant?.role !== "owner") {
      reply.code(404);
      return { error: "Not found" };
    }
    return { shares: await listShares(request.params.id) };
  });

  /**
   * Share with a user, or change their role. Idempotent by (conversation,
   * user) — re-sharing at a different role updates rather than duplicating,
   * which is what the PK already guarantees at the storage level.
   */
  app.put<{ Params: { id: string } }>("/v1/conversations/:id/shares", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const grant = await resolveAccess(userId, request.params.id);
    if (grant?.role !== "owner") {
      reply.code(404);
      return { error: "Not found" };
    }

    const body = request.body as { user_id?: unknown; role?: unknown };
    const targetId = typeof body.user_id === "string" ? body.user_id : "";
    const role = isShareRole(body.role) ? body.role : "viewer";
    if (!targetId) {
      reply.code(400);
      return { error: "user_id is required" };
    }
    // Sharing with yourself is a no-op at best and, if it were stored, a
    // share row that outranks nothing and confuses the owner's own role
    // resolution. Reject it rather than write it.
    if (targetId === userId) {
      reply.code(400);
      return { error: "You already own this conversation" };
    }
    const target = await db.query.user.findFirst({
      where: eq(user.id, targetId),
      columns: { id: true },
    });
    if (!target) {
      reply.code(404);
      return { error: "Not found" };
    }

    await db
      .insert(conversationShares)
      .values({ conversationId: request.params.id, userId: targetId, role, createdBy: userId })
      .onConflictDoUpdate({
        target: [conversationShares.conversationId, conversationShares.userId],
        set: { role, createdBy: userId },
      });
    return { shares: await listShares(request.params.id) };
  });

  /**
   * Revoke a share.
   *
   * Takes effect on the revoked user's *next* command, not immediately: their
   * live socket keeps whatever stream it is already tapped into until it
   * re-subscribes. That is a deliberate limit rather than an oversight —
   * every command re-authorizes through the chokepoint, so nothing new
   * reaches them, and forcibly severing an in-flight stream would need a
   * cross-connection kill path that does not exist yet. Worth knowing before
   * treating revoke as an emergency control.
   */
  app.delete<{ Params: { id: string; userId: string } }>(
    "/v1/conversations/:id/shares/:userId",
    async (request, reply) => {
      const userId = await authenticate(request, reply);
      const grant = await resolveAccess(userId, request.params.id);
      if (grant?.role !== "owner") {
        reply.code(404);
        return { error: "Not found" };
      }
      await db
        .delete(conversationShares)
        .where(
          and(
            eq(conversationShares.conversationId, request.params.id),
            eq(conversationShares.userId, request.params.userId),
          ),
        );
      return { shares: await listShares(request.params.id) };
    },
  );

  /**
   * People to share with. Deliberately minimal and deliberately not a
   * directory: it requires a search term, matches only the start of a name or
   * email, caps hard, and returns nothing without input — so it answers "is
   * this person here" for someone you already know, without enumerating the
   * deployment's users to anyone who asks.
   */
  app.get("/v1/users/search", async (request, reply) => {
    const userId = await authenticate(request, reply);
    // Type-checked rather than String()-coerced: `?q[]=a&q[]=b` arrives as an
    // array, and stringifying that would search for "[object Object]".
    const raw = (request.query as { q?: unknown }).q;
    const q = typeof raw === "string" ? raw.trim() : "";
    if (q.length < 2) return { users: [] };
    // `%` and `_` are ILIKE wildcards. Parameterization keeps them out of the
    // SQL, but not out of the *pattern*: `q="%@"` is two characters, clears the
    // length guard, and matches every email on the deployment — walk `%a%`,
    // `%b%`, … and the "not a directory" guarantee above is gone. Escape them
    // so the prefix match is a prefix match.
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(and(ne(user.id, userId), or(ilike(user.name, like), ilike(user.email, like))))
      .limit(10);
    return { users: rows };
  });
}

export function adminConversationRoutes(app: FastifyInstance) {
  /**
   * Every conversation on this deployment, for the admin screen.
   *
   * Metadata only — owner, title, activity, how many people it is shared
   * with. Reading a thread's *contents* still goes through the normal route,
   * where an admin resolves to `viewer`; there is no bulk content endpoint
   * here, deliberately.
   */
  app.get("/v1/admin/conversations", async (request, reply) => {
    await requireAdmin(request, reply);
    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        kind: conversations.kind,
        ownerId: conversations.ownerId,
        ownerName: user.name,
        ownerEmail: user.email,
        updatedAt: conversations.updatedAt,
        createdAt: conversations.createdAt,
        deletedAt: conversations.deletedAt,
        deletedHold: conversations.deletedHold,
      })
      // Deleted conversations are included here and nowhere else. This is the
      // audit view retention exists for, so hiding them would leave the
      // feature with no way to reach what it kept; every *other* reader still
      // filters them out, and `resolveAccess` still refuses them, so nothing
      // about a retained conversation becomes reachable through an ordinary
      // path because of this.
      .from(conversations)
      .innerJoin(user, eq(user.id, conversations.ownerId))
      .orderBy(desc(conversations.updatedAt))
      .limit(200);

    const shares = await db
      .select({ conversationId: conversationShares.conversationId })
      .from(conversationShares);
    const shareCounts = new Map<string, number>();
    for (const s of shares) {
      shareCounts.set(s.conversationId, (shareCounts.get(s.conversationId) ?? 0) + 1);
    }

    return rows.map((row) => ({
      ...row,
      shareCount: shareCounts.get(row.id) ?? 0,
      // Derived on read, never stored: an admin who shortens the window has
      // shortened it for every row already retained, and a stored date would
      // have this screen promising one the sweep will not honour.
      purgeAt: row.deletedAt ? conversationPurgeAt(row.deletedAt, row.deletedHold) : null,
    }));
  });

  /**
   * One conversation's messages, read-only, for the admin screen.
   *
   * The only way to read a *retained* conversation — that is what retention is
   * for. It is not a loosening of `resolveAccess`, which still refuses a
   * deleted row everywhere else including every socket: this is a separate,
   * admin-gated, read-only door, and the audit trail an admin is expected to
   * use is their own `requireAdmin` session.
   *
   * Attachments are named, not served. `/v1/files/:ref` keeps its own
   * `c.deleted_at IS NULL` condition, so the bytes of a deleted conversation's
   * uploads stay unreachable; the filename in the transcript is what an admin
   * needs to know something was attached.
   */
  app.get<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/messages",
    async (request, reply) => {
      await requireAdmin(request, reply);
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.id, request.params.id),
        columns: { id: true },
      });
      if (!conv) {
        reply.code(404);
        return { error: "Not found" };
      }
      const rows = await db
        .select({
          id: messages.id,
          authorType: messages.authorType,
          authorUserId: messages.authorUserId,
          model: messages.model,
          content: messages.content,
          status: messages.status,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(eq(messages.conversationId, request.params.id), isNull(messages.deletedAt)))
        .orderBy(messages.createdAt)
        .limit(500);
      return { messages: rows };
    },
  );

  /**
   * Restore a retained conversation to its owner.
   *
   * 404 unless it is actually retained: restoring a live conversation is not a
   * thing, and answering "ok" to it would tell an admin something happened.
   */
  app.post<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/restore",
    async (request, reply) => {
      await requireAdmin(request, reply);
      if (!(await isRetained(request.params.id))) {
        reply.code(404);
        return { error: "Not found" };
      }
      await restoreConversation(request.params.id);
      return { ok: true };
    },
  );

  /**
   * Erase a retained conversation now, rather than waiting for its window.
   *
   * The answer to "the owner asked us to actually delete it" and to an audit
   * that finished early. Same erasure the sweep performs, so there is one
   * definition of gone.
   */
  app.post<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/purge",
    async (request, reply) => {
      await requireAdmin(request, reply);
      if (!(await isRetained(request.params.id))) {
        reply.code(404);
        return { error: "Not found" };
      }
      await purgeConversation(request.params.id, request.log);
      return { ok: true };
    },
  );

  /**
   * Hold a retained conversation past its window, or release it back to it.
   *
   * An audit that outlasts the retention window is the ordinary case — 30 days
   * is a storage policy, not an estimate of how long a question takes to
   * answer — and without this the sweep would erase the evidence mid-enquiry.
   */
  app.patch<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/hold",
    async (request, reply) => {
      await requireAdmin(request, reply);
      const { hold } = (request.body ?? {}) as { hold?: unknown };
      if (typeof hold !== "boolean") {
        reply.code(400);
        return { error: "hold must be a boolean" };
      }
      if (!(await isRetained(request.params.id))) {
        reply.code(404);
        return { error: "Not found" };
      }
      await db
        .update(conversations)
        .set({ deletedHold: hold })
        .where(eq(conversations.id, request.params.id));
      return { ok: true };
    },
  );

  /** One conversation's shares, for the admin screen's detail view. */
  app.get<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/shares",
    async (request, reply) => {
      await requireAdmin(request, reply);
      return { shares: await listShares(request.params.id) };
    },
  );

  /**
   * Change a conversation's shares as an admin.
   *
   * The issue's ask is "an admin can change permissions", and this is exactly
   * that and no more: grant or revoke access. It cannot send, delete, or
   * transfer ownership — an admin who needs to act in a conversation grants
   * themselves editor here, which is recorded in `createdBy` for whoever
   * reads the row later.
   */
  app.patch<{ Params: { id: string } }>(
    "/v1/admin/conversations/:id/shares",
    async (request, reply) => {
      const adminId = await requireAdmin(request, reply);
      const body = request.body as { user_id?: unknown; role?: unknown; revoke?: unknown };
      const targetId = typeof body.user_id === "string" ? body.user_id : "";
      if (!targetId) {
        reply.code(400);
        return { error: "user_id is required" };
      }
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.id, request.params.id),
        columns: { id: true, ownerId: true },
      });
      if (!conv) {
        reply.code(404);
        return { error: "Not found" };
      }
      if (targetId === conv.ownerId) {
        reply.code(400);
        return { error: "That user owns this conversation" };
      }
      // Same guard the owner-facing PUT has. Without it an unknown id (a
      // removed account, a typo) lands on the FK and surfaces as a 500
      // carrying raw database text, where the sibling route gives a clean 404.
      if (body.revoke !== true) {
        const target = await db.query.user.findFirst({
          where: eq(user.id, targetId),
          columns: { id: true },
        });
        if (!target) {
          reply.code(404);
          return { error: "Not found" };
        }
      }

      if (body.revoke === true) {
        await db
          .delete(conversationShares)
          .where(
            and(
              eq(conversationShares.conversationId, request.params.id),
              eq(conversationShares.userId, targetId),
            ),
          );
      } else {
        const role = isShareRole(body.role) ? body.role : "viewer";
        await db
          .insert(conversationShares)
          .values({ conversationId: request.params.id, userId: targetId, role, createdBy: adminId })
          .onConflictDoUpdate({
            target: [conversationShares.conversationId, conversationShares.userId],
            set: { role, createdBy: adminId },
          });
      }
      return { shares: await listShares(request.params.id) };
    },
  );
}
