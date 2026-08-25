import { EventEmitter } from "node:events";

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
