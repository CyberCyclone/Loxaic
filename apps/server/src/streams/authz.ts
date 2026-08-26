import { db, eq, inArray } from "@shannon/db";
import { attachments, conversations, messages } from "@shannon/db/schema";
import type { AttachmentRef } from "@shannon/types";
import { MAX_ATTACHMENTS } from "@shannon/types";
import { getStreamBroker } from "./index.ts";
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

export interface AccessGrant { conversationId: string; incognito: boolean }

/**
 * Single authz chokepoint for every conversation-scoped WS command
 * (chat.send/agent.send with a conversation_id, stream.subscribe, and via
 * stream meta's userId: stream.stop/agent.approve/agent.deny). Resolves via
 * Postgres first, then the ephemeral (incognito) registry — always checking
 * both, even once one has already matched, so response timing doesn't leak
 * which of "not found" vs "found but not yours" actually happened.
 */
export async function assertConversationAccess(userId: string, conversationId: string): Promise<AccessGrant> {
  const [row, econv] = await Promise.all([
    db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { id: true, ownerId: true },
    }),
    getStreamBroker().driver.getEphemeralConv(conversationId),
  ]);
  if (row?.ownerId === userId) return { conversationId, incognito: false };
  if (econv?.ownerId === userId) return { conversationId, incognito: true };
  throw new NotFoundError();
}

/** Guards against a client-supplied parent_id pointing at a message in a
 * different conversation — messages carry no FK, so this is otherwise
 * silently accepted. Only meaningful for non-incognito parents (incognito
 * message ids are never Postgres rows). */
export async function assertParentInConversation(conversationId: string, parentId: string): Promise<void> {
  const row = await db.query.messages.findFirst({
    where: eq(messages.id, parentId),
    columns: { conversationId: true },
  });
  if (row?.conversationId !== conversationId) throw new NotFoundError();
}

/**
 * Validates every attachment ref on an incoming send before the run writes
 * anything. Returns the refs with their authoritative mimes (the client's
 * copy is advisory only). Unknown ref and someone else's ref are the same
 * NotFoundError — same no-oracle rule as conversations.
 */
export async function assertAttachmentsOwned(userId: string, refs: string[]): Promise<AttachmentRef[]> {
  if (refs.length === 0) return [];
  if (refs.length > MAX_ATTACHMENTS) throw new NotFoundError();
  // A malformed ref must fail the same way as a missing one — and must never
  // reach the uuid-typed query, where Postgres would error instead.
  if (!refs.every(isValidRef)) throw new NotFoundError();
  const rows = await db
    .select({ id: attachments.id, ownerId: attachments.ownerId, mime: attachments.mime })
    .from(attachments)
    .where(inArray(attachments.id, refs));
  const byId = new Map(rows.filter((r) => r.ownerId === userId).map((r) => [r.id, r]));
  return refs.map((ref) => {
    const row = byId.get(ref);
    if (!row) throw new NotFoundError();
    return { ref, mime: row.mime };
  });
}
