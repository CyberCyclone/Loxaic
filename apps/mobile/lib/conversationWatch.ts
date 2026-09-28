import { isServerConvId } from './streamMessages';

/**
 * Which conversations this socket is watching for runs it did not start.
 *
 * The server tells a socket about a new run on a conversation only if the
 * socket has subscribed to that conversation — that is what installs the
 * watch (ws/delivery.ts). The hooks used to subscribe only on socket open
 * and on a seq gap, "enough for Chat, where a run always starts from this
 * client". Automatic compaction broke that: the server starts it right after
 * a turn, and a phone that had created or opened the conversation during this
 * connection heard nothing until its next reconnect — on the beta, a card
 * that appeared on returning to the app, with no Stop and a composer that
 * looked free, twelve minutes into a compaction.
 *
 * Pure bookkeeping, one per socket: a new socket starts with nothing watched,
 * and its reconnect subscribes afresh.
 */
export class ConversationWatches {
  private readonly watched = new Set<string>();

  /** True the first time a real conversation id is seen on this socket —
   * the caller then sends its `stream.subscribe`. */
  claim(conversationId: string | null | undefined): conversationId is string {
    if (!conversationId || !isServerConvId(conversationId) || this.watched.has(conversationId)) return false;
    this.watched.add(conversationId);
    return true;
  }

  /** Marks ids a reconnect already subscribed. */
  note(conversationIds: Iterable<string>): void {
    for (const id of conversationIds) if (isServerConvId(id)) this.watched.add(id);
  }

  reset(): void {
    this.watched.clear();
  }
}
