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

/** Something that happened to a conversation itself rather than in one run:
 * messages removed from its end (conversations/rewind.ts), or its workspace
 * moved to another image (routes/conversations.ts). */
export type ConversationEvent = Extract<ServerMessage, { type: "conversation.rewound" | "conversation.workspace" }>;

const EVENT_CHANNEL = (conversationId: string) => `event:${conversationId}`;

/**
 * Process-local channel for "a run's activity on some conversation just
 * changed" (#282) — started, queued, moved in the queue, parked on a person,
 * picked back up, or ended.
 *
 * One channel rather than one per conversation, because the change is announced
 * by the run registry without knowing who is listening, and every listener
 * cares about a different set: `delivery.ts` filters each notice down to the
 * conversations its socket asked to watch. The notice itself carries only the
 * conversation id — the listener reads the run's current state off the
 * registry, so a socket that hears two changes in one tick sends only the
 * latest truth.
 */
const ACTIVITY_CHANNEL = "run-activity";

/** Called by the registry whenever a run's reported activity may have changed. */
export function announceRunActivity(conversationId: string): void {
  emitter.emit(ACTIVITY_CHANNEL, conversationId);
}

export function watchRunActivity(onActivity: (conversationId: string) => void): () => void {
  emitter.on(ACTIVITY_CHANNEL, onActivity);
  return () => emitter.off(ACTIVITY_CHANNEL, onActivity);
}

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
