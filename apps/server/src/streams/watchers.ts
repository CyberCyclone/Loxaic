import { EventEmitter } from "node:events";
import type { ServerMessage } from "@loxaic/types";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * Process-local notice board for "a brand-new run just started on this
 * conversation" — distinct from StreamBroker's per-stream taps, since a
 * socket idly watching a conversation has no stream id to tap until a run
 * actually exists. Without this, a second device already looking at a
 * conversation only learns about a run another device started on the same
 * conversation by reconnecting or re-sending `stream.subscribe` — with it,
 * `delivery.ts`'s `handleSubscribe` stays subscribed to a conversation for
 * the life of the socket and picks up new runs live, no polling.
 */
export function announceNewRun(conversationId: string, streamId: string): void {
  emitter.emit(conversationId, streamId);
}

export function watchConversation(conversationId: string, onNewRun: (streamId: string) => void): () => void {
  emitter.on(conversationId, onNewRun);
  return () => emitter.off(conversationId, onNewRun);
}

/** Something that happened to a conversation itself rather than in one run —
 * today only messages being removed from its end (conversations/rewind.ts). */
export type ConversationEvent = Extract<ServerMessage, { type: "conversation.rewound" }>;

const EVENT_CHANNEL = (conversationId: string) => `event:${conversationId}`;

/** Tells every socket watching `conversationId`. Each re-authorizes before it
 * passes the event on (`delivery.ts`), as it does for a new run. */
export function announceConversationEvent(event: ConversationEvent): void {
  emitter.emit(EVENT_CHANNEL(event.conversation_id), event);
}

export function watchConversationEvents(
  conversationId: string,
  onEvent: (event: ConversationEvent) => void,
): () => void {
  const channel = EVENT_CHANNEL(conversationId);
  emitter.on(channel, onEvent);
  return () => emitter.off(channel, onEvent);
}
