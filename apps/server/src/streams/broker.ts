import { EventEmitter } from "node:events";
import type { StreamEventKind, StreamSnapshot, StreamSnapshotMessage, TurnUsage } from "@loxaic/types";
import type { StreamLogDriver, StreamMeta, StreamRecord } from "./types.ts";

export type StreamProducerMeta = Omit<StreamMeta, "lastSeq" | "status" | "updatedAt" | "createdAt">;

export interface StreamEndInfo { usage?: TurnUsage; error?: string }

export interface StreamProducer {
  emit(event: StreamEventKind): void;
  end(status: "complete" | "error" | "cancelled", info?: StreamEndInfo): Promise<void>;
}

const isDeltaEvent = (e: StreamEventKind) => e.kind === "text.delta" || e.kind === "thinking.delta";

/**
 * Wraps a StreamLogDriver with producer-side coalescing and in-process live
 * fan-out. The server is a single process, so "pub/sub" here is just an
 * EventEmitter — Redis is used for durability and catch-up (readFrom), never
 * for delivery. If this ever needs to run as more than one process, fan-out
 * moves into the Redis driver behind this exact same public API.
 */
export class StreamBroker {
  private emitter = new EventEmitter();

  constructor(
    public readonly driver: StreamLogDriver,
    private coalesceMs: number,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async openProducer(meta: StreamProducerMeta): Promise<StreamProducer> {
    await this.driver.createStream({ ...meta, createdAt: Date.now() });
    const streamId = meta.streamId;

    let buffer: StreamEventKind[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let ended = false;

    const flush = async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (buffer.length === 0) return;
      const toAppend = buffer;
      buffer = [];
      const records = await this.driver.append(streamId, toAppend);
      // Subscribers only ever see events that are already durable — append
      // completes before any live emit.
      for (const record of records) this.emitter.emit(streamId, record);
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        void flush();
      }, this.coalesceMs);
    };

    return {
      emit: (event: StreamEventKind) => {
        if (ended) return;
        buffer.push(event);
        if (isDeltaEvent(event)) {
          scheduleFlush();
        } else {
          // Structural events (tool calls, message boundaries, …) must never
          // land out of order relative to already-buffered deltas — force a
          // flush of everything accumulated so far, right now.
          void flush();
        }
      },
      end: async (status, info) => {
        if (ended) return;
        ended = true;
        await flush();
        await this.driver.finalize(streamId, status);
        // A distinct event name from the record channel (which uses the bare
        // streamId) — delivery taps this separately to know when to send the
        // client a `stream.end` (as opposed to another `stream.event`).
        this.emitter.emit(`${streamId}:end`, { status, usage: info?.usage, error: info?.error });
      },
    };
  }

  /** Live tap: fires for every record appended after subscription. Does NOT
   * replay history — pair with `readFrom`/`foldSnapshot` for catch-up. */
  onRecord(streamId: string, cb: (record: StreamRecord) => void): () => void {
    this.emitter.on(streamId, cb);
    return () => this.emitter.off(streamId, cb);
  }

  /** Fires once, when the run finalizes (any terminal status). */
  onEnd(
    streamId: string,
    cb: (info: { status: "complete" | "error" | "cancelled"; usage?: TurnUsage; error?: string }) => void,
  ): () => void {
    const event = `${streamId}:end`;
    this.emitter.on(event, cb);
    return () => this.emitter.off(event, cb);
  }

  readFrom(streamId: string, afterSeq: number): Promise<StreamRecord[]> {
    return this.driver.readFrom(streamId, afterSeq);
  }

  getMeta(streamId: string): Promise<StreamMeta | null> {
    return this.driver.getMeta(streamId);
  }

  listActive(conversationId: string): Promise<StreamMeta[]> {
    return this.driver.listActive(conversationId);
  }

  /** Folds a run's durable log into "everything so far" — shared by the
   * catch-up delivery path and boot-time orphan recovery. */
  foldSnapshot(records: StreamRecord[]): StreamSnapshot {
    const messages = new Map<string, StreamSnapshotMessage>();
    const orderedMessages: StreamSnapshotMessage[] = [];
    let queued: StreamSnapshot["queued"];
    let iteration: StreamSnapshot["iteration"];
    let todos: StreamSnapshot["todos"];
    let pendingApproval: StreamSnapshot["pending_approval"];
    let pendingCheckin: StreamSnapshot["pending_checkin"];
    let promptStats: StreamSnapshot["prompt_stats"];

    const ensure = (id: string): StreamSnapshotMessage => {
      let m = messages.get(id);
      if (!m) {
        m = {
          message_id: id,
          author_type: "assistant",
          parent_id: null,
          text: "",
          thinking: "",
          tool_calls: [],
          status: "streaming",
        };
        messages.set(id, m);
        orderedMessages.push(m);
      }
      return m;
    };

    for (const { event } of records) {
      // Any event that is not itself a queue update means the run is past the
      // queue, so the position is dropped *before* the fold: `iteration` used
      // to be the only clear-point, and a compaction run never emits one — a
      // client catching up mid-summary was shown a queue position the run had
      // long left. (The same held for an agent run re-queued after an
      // approval, between its tool calls and its next iteration.)
      if (event.kind !== "run.queued") queued = undefined;
      switch (event.kind) {
        case "message.start": {
          const m = ensure(event.message_id);
          m.author_type = event.author_type;
          m.parent_id = event.parent_id;
          if (event.lamport !== undefined) m.lamport = event.lamport;
          if (event.model) m.model = event.model;
          if (event.text) m.text = event.text;
          if (event.attachments?.length) m.attachments = event.attachments;
          // Only when the key is present: absent means "not told", and folding
          // it in as null would turn an old event into a claim that nobody
          // answered.
          if ("author_user_id" in event) m.author_user_id = event.author_user_id ?? null;
          break;
        }
        case "text.delta":
          ensure(event.message_id).text += event.text;
          if (promptStats?.message_id === event.message_id) promptStats = undefined;
          break;
        case "thinking.delta":
          ensure(event.message_id).thinking += event.text;
          if (promptStats?.message_id === event.message_id) promptStats = undefined;
          break;
        case "prompt.stats": {
          const { kind: _kind, ...stats } = event;
          void _kind;
          promptStats = stats;
          break;
        }
        case "message.usage":
          // Folded, not transient: a client reconnecting mid-turn — parked at
          // an approval, say — would otherwise see no context figure until the
          // turn ended, which is #193 again by another route.
          ensure(event.message_id).usage = event.usage;
          break;
        case "message.end": {
          if (promptStats?.message_id === event.message_id) promptStats = undefined;
          const m = ensure(event.message_id);
          m.status = event.status;
          if (event.usage) m.usage = event.usage;
          if (event.error) m.error = event.error;
          break;
        }
        case "model.loading":
          // Transient-only — not meaningful to fold into a catch-up snapshot.
          break;
        case "run.queued":
          queued = { position: event.position };
          break;
        case "iteration":
          iteration = { n: event.n, max: event.max };
          // Reaching an iteration *is* the run moving on, so a check-in
          // cannot still be outstanding. Belt and braces beside
          // `steps.decision`, which is the real clear-point.
          pendingCheckin = undefined;
          break;
        case "steps.checkin": {
          const { kind: _kind, ...question } = event;
          void _kind;
          // Every field, deadline included: someone reconnecting mid-wait is
          // exactly who needs to know how long is left, and what happens then.
          pendingCheckin = question;
          // The question names the step it paused at, so a client that joins
          // mid-wait can show "104/200" rather than nothing.
          iteration = { n: event.n, max: event.max };
          break;
        }
        case "steps.decision": {
          pendingCheckin = undefined;
          // An unattended decision is the one kind that leaves nothing else in
          // the transcript — "keep going" writes no message — so it is kept
          // here, on the assistant message whose tools the check-in followed.
          // That is always the last assistant message seen: a check-in comes
          // right after an iteration's tool results, before the next one starts.
          if (event.by === "timeout") {
            const lastAssistant = [...orderedMessages].reverse().find((m) => m.author_type === "assistant");
            if (lastAssistant) {
              const { kind: _kind, ...note } = event;
              void _kind;
              lastAssistant.checkin_decision = note;
            }
          }
          break;
        }
        case "tool.call":
          if (promptStats?.message_id === event.message_id) promptStats = undefined;
          ensure(event.message_id).tool_calls.push({
            call_id: event.call_id,
            tool: event.tool,
            args: event.args,
          });
          break;
        case "approval.request": {
          const { kind: _kind, ...request } = event;
          void _kind;
          pendingApproval = request;
          break;
        }
        case "tool.result": {
          const m = ensure(event.message_id);
          const call = m.tool_calls.find((t) => t.call_id === event.call_id);
          if (call) {
            call.output = event.output;
            call.ok = event.ok;
            call.diff = event.diff;
          }
          if (pendingApproval?.call_id === event.call_id) pendingApproval = undefined;
          break;
        }
        case "todos":
          todos = event.todos;
          break;
        case "compaction": {
          const { kind: _kind, message_id, ...stats } = event;
          void _kind;
          ensure(message_id).compaction = stats;
          break;
        }
      }
    }

    return {
      messages: orderedMessages,
      ...(queued ? { queued } : {}),
      ...(iteration ? { iteration } : {}),
      ...(todos ? { todos } : {}),
      ...(pendingApproval ? { pending_approval: pendingApproval } : {}),
      ...(pendingCheckin ? { pending_checkin: pendingCheckin } : {}),
      ...(promptStats ? { prompt_stats: promptStats } : {}),
    };
  }
}
