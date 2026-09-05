import type { StreamEventKind, StreamStatus } from "@shannon/types";

export interface StreamRecord { seq: number; ts: number; event: StreamEventKind }

export interface StreamMeta {
  streamId: string;
  conversationId: string;
  userId: string;
  surface: "chat" | "agent";
  status: StreamStatus;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage contract for the durable stream log. Implementations only store —
 * live fan-out to connected sockets is the StreamBroker's job, not the
 * driver's, so both drivers stay dumb and interchangeable. A single producer
 * owns each stream, so `append` needs no cross-process atomicity: seq is a
 * per-stream counter the driver just persists alongside the records.
 */
export interface StreamLogDriver {
  createStream(meta: Omit<StreamMeta, "lastSeq" | "status" | "updatedAt">): Promise<StreamMeta>;
  /** Assigns contiguous seqs starting at lastSeq+1 and returns the appended records. */
  append(streamId: string, events: StreamEventKind[]): Promise<StreamRecord[]>;
  readFrom(streamId: string, afterSeq: number): Promise<StreamRecord[]>;
  getMeta(streamId: string): Promise<StreamMeta | null>;
  finalize(streamId: string, status: "complete" | "error" | "cancelled"): Promise<void>;
  /** Streams with status "active" for a conversation — what a fresh subscribe replies with. */
  listActive(conversationId: string): Promise<StreamMeta[]>;
  /** Every stream still "active" globally — boot-time orphan recovery. */
  listOrphaned(): Promise<StreamMeta[]>;
  deleteStream(streamId: string): Promise<void>;

  /** All run ids for a conversation, oldest → newest. */
  listConvStreams(conversationId: string): Promise<string[]>;
}
