import { and, db, eq, inArray } from "@shannon/db";
import { attachments, conversationShares, conversations, messages, user } from "@shannon/db/schema";
import type { AttachmentRef } from "@shannon/types";
import { MAX_ATTACHMENTS } from "@shannon/types";
import { isValidRef } from "../files/storage.ts";

/** Thrown for both "doesn't exist" and "exists but isn't yours" — the two
 * must be indistinguishable to the caller. Never branch on which case this
 * was; every call site renders it as the same generic error. */
export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

/**
 * What a user may do in a conversation, weakest first. Ordered so a minimum
 * requirement is a numeric comparison rather than a set of special cases —
 * see `atLeast`.
 *
 * `viewer` reads and streams. `editor` also sends, stops runs, and answers
 * tool approvals. `owner` additionally reconfigures the conversation: sharing,
 * renaming, deleting, model and MCP preferences — and the sandbox terminal,
 * which is arbitrary code execution rather than participation in a chat.
 */
export const ROLES = ["viewer", "editor", "owner"] as const;
export type ConversationRole = (typeof ROLES)[number];

const RANK: Record<ConversationRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function atLeast(role: ConversationRole, minimum: ConversationRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export interface AccessGrant {
  conversationId: string;
  role: ConversationRole;
  /** True when the grant came from the admin role rather than ownership or an
   * explicit share. Callers that must not let an admin *act* (as opposed to
   * look) branch on this rather than on the role. */
  viaAdmin: boolean;
}

/**
 * Single authz chokepoint for every conversation-scoped WS command
 * (chat.send/agent.send with a conversation_id, stream.subscribe, and via
 * stream meta's userId: stream.stop/agent.approve/agent.deny).
 *
 * Resolution order is owner → explicit share → admin. Admin comes last and
 * grants only `viewer`: an admin can see any conversation, which the product
 * requires, but "see" is not "act" — an admin who wants to participate can
 * share the conversation to themselves, and that leaves a row saying so.
 *
 * "Doesn't exist", "exists but isn't shared with you", and "shared but at too
 * low a role" must stay indistinguishable to the caller — every one of them
 * surfaces as the same NotFoundError. Never branch on which it was.
 */
export async function assertConversationAccess(
  userId: string,
  conversationId: string,
  minimum: ConversationRole = "viewer",
): Promise<AccessGrant> {
  const grant = await resolveAccess(userId, conversationId);
  if (!grant || !atLeast(grant.role, minimum)) throw new NotFoundError();
  return grant;
}

/** The grant itself, or null. Separate from the assert so callers that need
 * to *decide* rather than *reject* (the attachment reader, the sidebar) don't
 * have to catch an exception to ask a question. */
export async function resolveAccess(
  userId: string,
  conversationId: string,
): Promise<AccessGrant | null> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, ownerId: true },
  });
  if (!row) return null;
  if (row.ownerId === userId) return { conversationId, role: "owner", viaAdmin: false };

  const share = await db.query.conversationShares.findFirst({
    where: and(
      eq(conversationShares.conversationId, conversationId),
      eq(conversationShares.userId, userId),
    ),
    columns: { role: true },
  });
  if (share) return { conversationId, role: share.role, viaAdmin: false };

  if (await isAdmin(userId)) return { conversationId, role: "viewer", viaAdmin: true };
  return null;
}

/** Admin lookup, by id rather than by session, because the WS path has only
 * the user id by the time authorization runs. */
async function isAdmin(userId: string): Promise<boolean> {
  const row = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { role: true },
  });
  return row?.role === "admin";
}

/** Guards against a client-supplied parent_id pointing at a message in a
 * different conversation — messages carry no FK, so this is otherwise
 * silently accepted. */
export async function assertParentInConversation(conversationId: string, parentId: string): Promise<void> {
  const row = await db.query.messages.findFirst({
    where: eq(messages.id, parentId),
    columns: { conversationId: true },
  });
  if (row?.conversationId !== conversationId) throw new NotFoundError();
}

/**
 * Validates every attachment ref on an incoming send before the run writes
 * anything. Returns the refs with their authoritative mimes and filenames
 * (the client's copies are advisory only). Unknown ref and someone else's ref are the same
 * NotFoundError — same no-oracle rule as conversations.
 */
export async function assertAttachmentsOwned(userId: string, refs: string[]): Promise<AttachmentRef[]> {
  if (refs.length === 0) return [];
  // Cap the raw input, before de-duplication: an over-long array is malformed
  // however many distinct refs it happens to contain.
  if (refs.length > MAX_ATTACHMENTS) throw new NotFoundError();
  // A malformed ref must fail the same way as a missing one — and must never
  // reach the uuid-typed query, where Postgres would error instead. isValidRef
  // type-guards as well as pattern-matches, so a non-string element that TS
  // can't see (this array came off a socket) is rejected here too.
  if (!refs.every(isValidRef)) throw new NotFoundError();
  // The same ref four times is not four images — it is one image charged four
  // times. It would persist as four attachment blocks, emit four times in
  // message.start, and rebuild into four identical image parts on every future
  // replay, forever: a 4x prompt amplification off a single upload. Collapse to
  // first occurrence, which also preserves display order.
  const unique = [...new Set(refs)];
  const rows = await db
    .select({
      id: attachments.id,
      ownerId: attachments.ownerId,
      mime: attachments.mime,
      filename: attachments.filename,
    })
    .from(attachments)
    .where(inArray(attachments.id, unique));
  const byId = new Map(rows.filter((r) => r.ownerId === userId).map((r) => [r.id, r]));
  return unique.map((ref) => {
    const row = byId.get(ref);
    if (!row) throw new NotFoundError();
    // Both mime and name come from the row, never the client's copy — the
    // name is going into a prompt and a Content-Disposition header, so its
    // provenance matters as much as the mime's. Empty for rows predating
    // documents, and omitted rather than sent as "".
    return { ref, mime: row.mime, ...(row.filename ? { name: row.filename } : {}) };
  });
}
