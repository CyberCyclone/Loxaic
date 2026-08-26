import { EventEmitter } from "node:events";
import type { StreamEventKind, StreamSnapshot, StreamSnapshotMessage, TurnUsage } from "@shannon/types";
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
    let iteration: StreamSnapshot["iteration"];
    let todos: StreamSnapshot["todos"];
    let pendingApproval: StreamSnapshot["pending_approval"];

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
      switch (event.kind) {
        case "message.start": {
          const m = ensure(event.message_id);
          m.author_type = event.author_type;
          m.parent_id = event.parent_id;
          if (event.model) m.model = event.model;
          if (event.text) m.text = event.text;
          if (event.attachments?.length) m.attachments = event.attachments;
          break;
        }
        case "text.delta":
          ensure(event.message_id).text += event.text;
          break;
        case "thinking.delta":
          ensure(event.message_id).thinking += event.text;
          break;
        case "message.end": {
          const m = ensure(event.message_id);
          m.status = event.status;
          if (event.usage) m.usage = event.usage;
          if (event.error) m.error = event.error;
          break;
        }
        case "model.loading":
          // Transient-only — not meaningful to fold into a catch-up snapshot.
          break;
        case "iteration":
          iteration = { n: event.n, max: event.max };
          break;
        case "tool.call":
          ensure(event.message_id).tool_calls.push({
            call_id: event.call_id,
            tool: event.tool,
            args: event.args,
          });
          break;
        case "approval.request":
          pendingApproval = { call_id: event.call_id, tool: event.tool, args: event.args };
          break;
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
      ...(iteration ? { iteration } : {}),
      ...(todos ? { todos } : {}),
      ...(pendingApproval ? { pending_approval: pendingApproval } : {}),
    };
  }
}
