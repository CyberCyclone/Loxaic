import { EventEmitter } from "node:events";
import type { DebugEvent, ServerMessage, TurnUsage } from "@shannon/types";

/**
 * Process-local pub/sub for dev-mode telemetry, modelled on `watchers.ts`.
 *
 * Deliberately NOT the durable stream log: raw SSE lines are high-frequency
 * and unbounded, and the memory driver never evicts an in-flight run's
 * records — routing them through the broker would grow RSS for the whole run,
 * bloat every reconnect's read-from-zero catch-up, and defeat the delta
 * coalescer. Here nothing is stored: an event that nobody is listening for
 * costs a `listenerCount` check, and capture exists only while a client's
 * panel is open.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Per-string cap. Raw MCP results are unbounded (the `huge` fixture returns
 * 150KB) and a request body carries every tool schema, so both need a ceiling
 * independent of the sanitizer's. */
export const DEBUG_PAYLOAD_CAP = 32 * 1024;

/** Raw SSE lines arrive one per token; batching keeps a fast local model from
 * turning into one WS frame per word. */
export const DEBUG_BATCH_LINES = 64;
export const DEBUG_BATCH_MS = 100;

export function capString(text: string, cap = DEBUG_PAYLOAD_CAP): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, cap).toString("utf8"), truncated: true };
}

export function hasDebugSubscribers(conversationId: string): boolean {
  return emitter.listenerCount(conversationId) > 0;
}

export function publishDebug(conversationId: string, event: DebugEvent): void {
  if (emitter.listenerCount(conversationId) === 0) return;
  const msg: ServerMessage = { type: "debug.event", conversation_id: conversationId, ts: Date.now(), event };
  emitter.emit(conversationId, msg);
}

export function subscribeDebug(
  conversationId: string,
  onEvent: (msg: ServerMessage) => void,
): () => void {
  emitter.on(conversationId, onEvent);
  return () => emitter.off(conversationId, onEvent);
}

/**
 * Per-socket subscription bookkeeping, shared by the chat and agent handlers.
 * Subscribing twice to the same conversation replaces the first listener, and
 * `close()` on socket teardown releases everything — a leaked listener would
 * otherwise keep publishing into a dead socket for the process's lifetime.
 */
export function createDebugSubscriptions(send: (msg: ServerMessage) => void): {
  subscribe(conversationId: string): void;
  unsubscribe(conversationId: string): void;
  close(): void;
} {
  const active = new Map<string, () => void>();
  return {
    subscribe(conversationId) {
      active.get(conversationId)?.();
      active.set(conversationId, subscribeDebug(conversationId, send));
    },
    unsubscribe(conversationId) {
      active.get(conversationId)?.();
      active.delete(conversationId);
    },
    close() {
      for (const off of active.values()) off();
      active.clear();
    },
  };
}

export type LineBatcher = { push(line: string): void; flush(): void };

/** Collects lines and flushes on whichever comes first: DEBUG_BATCH_LINES,
 * DEBUG_BATCH_MS, or an explicit flush at end of stream. */
export function createLineBatcher(
  emit: (lines: string[]) => void,
  opts: { maxLines?: number; maxMs?: number } = {},
): LineBatcher {
  const maxLines = opts.maxLines ?? DEBUG_BATCH_LINES;
  const maxMs = opts.maxMs ?? DEBUG_BATCH_MS;
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    emit(batch);
  };

  return {
    push(line: string) {
      pending.push(line);
      if (pending.length >= maxLines) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, maxMs);
        timer.unref();
      }
    },
    flush,
  };
}

/**
 * The model-layer tap shared by every run type. Callbacks are always handed
 * to `streamCompletion`, but each one re-checks for subscribers before doing
 * any work — so a panel opened mid-run starts capturing from that point
 * rather than staying blank until the next turn, and a run with no panel open
 * pays nothing beyond a listener count.
 */
export function createModelDebugTap(input: {
  conversationId: string;
  streamId: string;
  model: string;
  /** Resolved lazily: decrypting MCP credentials to redact with is only worth
   * it when someone is actually watching. */
  secrets?: () => Record<string, string>;
  redact?: (text: string, secrets: Record<string, string>) => string;
}): {
  onRequest: (body: unknown) => void;
  onRawLine: (line: string) => void;
  done: (result: { finishReason?: string | null; usage?: TurnUsage; durationMs: number }) => void;
  close: () => void;
} {
  const { conversationId, streamId, model } = input;
  const batcher = createLineBatcher((lines) =>
    publishDebug(conversationId, { channel: "model.raw", stream_id: streamId, lines }),
  );

  return {
    onRequest(body) {
      if (!hasDebugSubscribers(conversationId)) return;
      let json: string;
      try {
        json = JSON.stringify(body, null, 2) ?? "";
      } catch {
        json = "[unserializable request body]";
      }
      // Prior tool results replayed in `messages` can echo secret-bearing
      // text, so the request is redacted even though the body itself carries
      // no credentials.
      const secrets = input.secrets?.() ?? {};
      const redacted = input.redact && Object.keys(secrets).length > 0 ? input.redact(json, secrets) : json;
      const { text, truncated } = capString(redacted);
      publishDebug(conversationId, {
        channel: "model.request",
        stream_id: streamId,
        model,
        body: text,
        ...(truncated ? { truncated } : {}),
      });
    },
    onRawLine(line) {
      if (!hasDebugSubscribers(conversationId)) return;
      batcher.push(capString(line, 8 * 1024).text);
    },
    done(result) {
      batcher.flush();
      if (!hasDebugSubscribers(conversationId)) return;
      publishDebug(conversationId, {
        channel: "model.done",
        stream_id: streamId,
        finish_reason: result.finishReason ?? null,
        ...(result.usage ? { usage: result.usage } : {}),
        duration_ms: result.durationMs,
      });
    },
    close() {
      batcher.flush();
    },
  };
}
