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
