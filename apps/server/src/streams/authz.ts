import { db, eq } from "@shannon/db";
import { conversations, messages } from "@shannon/db/schema";
import { getStreamBroker } from "./index.ts";

/** Thrown for both "doesn't exist" and "exists but isn't yours" — the two
 * must be indistinguishable to the caller. Never branch on which case this
 * was; every call site renders it as the same generic error. */
export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

export type AccessGrant = { conversationId: string; incognito: boolean };

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
  if (row && row.ownerId === userId) return { conversationId, incognito: false };
  if (econv && econv.ownerId === userId) return { conversationId, incognito: true };
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
  if (!row || row.conversationId !== conversationId) throw new NotFoundError();
}
