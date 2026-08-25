import type { StreamEventKind } from "@shannon/types";
import type { EphemeralConv, StreamLogDriver, StreamMeta, StreamRecord } from "./types.ts";

type Entry = { meta: StreamMeta; records: StreamRecord[] };

/**
 * In-process driver — the bare `pnpm dev` default, zero new services. A
 * server crash loses every in-flight stream (nothing survives restart, by
 * construction: `listOrphaned()` always returns `[]` here since nothing
 * *could* still be "active" after the process holding it died). The
 * Postgres-side sweep in streams/recovery.ts is what cleans up the resulting
 * stuck "streaming" rows in this mode — memory mode's whole recovery story.
 */
export class MemoryStreamLogDriver implements StreamLogDriver {
  private streams = new Map<string, Entry>();
  private ephemeralConvs = new Map<string, EphemeralConv>();
  private convStreams = new Map<string, string[]>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(private ttlSeconds: number) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweep() {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    for (const [id, entry] of this.streams) {
      if (entry.meta.status !== "active" && entry.meta.updatedAt < cutoff) this.streams.delete(id);
    }
    for (const [id, conv] of this.ephemeralConvs) {
      if (conv.createdAt < cutoff) {
        this.ephemeralConvs.delete(id);
        this.convStreams.delete(id);
      }
    }
  }

  async createStream(meta: Omit<StreamMeta, "lastSeq" | "status" | "updatedAt">): Promise<StreamMeta> {
    const full: StreamMeta = { ...meta, status: "active", lastSeq: 0, updatedAt: Date.now() };
    this.streams.set(meta.streamId, { meta: full, records: [] });
    const list = this.convStreams.get(meta.conversationId) ?? [];
    list.push(meta.streamId);
    this.convStreams.set(meta.conversationId, list);
    return full;
  }

  async append(streamId: string, events: StreamEventKind[]): Promise<StreamRecord[]> {
    const entry = this.streams.get(streamId);
    if (!entry) throw new Error(`Unknown stream ${streamId}`);
    const now = Date.now();
    const out: StreamRecord[] = events.map((event) => {
      entry.meta.lastSeq += 1;
      return { seq: entry.meta.lastSeq, ts: now, event };
    });
    entry.records.push(...out);
    entry.meta.updatedAt = now;
    return out;
  }

  async readFrom(streamId: string, afterSeq: number): Promise<StreamRecord[]> {
    const entry = this.streams.get(streamId);
    if (!entry) return [];
    return entry.records.filter((r) => r.seq > afterSeq);
  }

  async getMeta(streamId: string): Promise<StreamMeta | null> {
    return this.streams.get(streamId)?.meta ?? null;
  }

  async finalize(streamId: string, status: "complete" | "error" | "cancelled"): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    entry.meta.status = status;
    entry.meta.updatedAt = Date.now();
  }

  async listActive(conversationId: string): Promise<StreamMeta[]> {
    const ids = this.convStreams.get(conversationId) ?? [];
    return ids
      .map((id) => this.streams.get(id)?.meta)
      .filter((m): m is StreamMeta => !!m && m.status === "active");
  }

  async listOrphaned(): Promise<StreamMeta[]> {
    return [];
  }

  async deleteStream(streamId: string): Promise<void> {
    this.streams.delete(streamId);
  }

  async putEphemeralConv(conv: EphemeralConv): Promise<void> {
    this.ephemeralConvs.set(conv.id, conv);
  }

  async getEphemeralConv(id: string): Promise<EphemeralConv | null> {
    return this.ephemeralConvs.get(id) ?? null;
  }

  async touchEphemeralConv(id: string): Promise<void> {
    const conv = this.ephemeralConvs.get(id);
    if (conv) conv.createdAt = Date.now();
  }

  async listConvStreams(conversationId: string): Promise<string[]> {
    return this.convStreams.get(conversationId) ?? [];
  }
}
