import type { StreamEventKind } from "@loxaic/types";
import type { StreamLogDriver, StreamMeta, StreamRecord } from "./types.ts";

interface Entry { meta: StreamMeta; records: StreamRecord[] }

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
  private convStreams = new Map<string, string[]>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(private ttlSeconds: number) {
    this.sweepTimer = setInterval(() => { this.sweep(); }, 60_000);
    this.sweepTimer.unref();
  }

  private sweep() {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    for (const [id, entry] of this.streams) {
      if (entry.meta.status !== "active" && entry.meta.updatedAt < cutoff) this.streams.delete(id);
    }
    // Prune the per-conversation run index in the same pass. It only ever
    // grew: createStream pushes on every run and nothing removed from it, so
    // a long-lived process (the packaged desktop app runs this driver for
    // days) accumulated an ever-longer list of ids whose streams were already
    // swept above. Drop the swept ids, and the conversation's entry once it
    // has none left.
    for (const [convId, ids] of this.convStreams) {
      const live = ids.filter((id) => this.streams.has(id));
      if (live.length === 0) this.convStreams.delete(convId);
      else if (live.length !== ids.length) this.convStreams.set(convId, live);
    }
  }

  createStream(meta: Omit<StreamMeta, "lastSeq" | "status" | "updatedAt">): Promise<StreamMeta> {
    const full: StreamMeta = { ...meta, status: "active", lastSeq: 0, updatedAt: Date.now() };
    this.streams.set(meta.streamId, { meta: full, records: [] });
    const list = this.convStreams.get(meta.conversationId) ?? [];
    list.push(meta.streamId);
    this.convStreams.set(meta.conversationId, list);
    return Promise.resolve(full);
  }

  append(streamId: string, events: StreamEventKind[]): Promise<StreamRecord[]> {
    const entry = this.streams.get(streamId);
    if (!entry) return Promise.reject(new Error(`Unknown stream ${streamId}`));
    const now = Date.now();
    const out: StreamRecord[] = events.map((event) => {
      entry.meta.lastSeq += 1;
      return { seq: entry.meta.lastSeq, ts: now, event };
    });
    entry.records.push(...out);
    entry.meta.updatedAt = now;
    return Promise.resolve(out);
  }

  readFrom(streamId: string, afterSeq: number): Promise<StreamRecord[]> {
    const entry = this.streams.get(streamId);
    if (!entry) return Promise.resolve([]);
    return Promise.resolve(entry.records.filter((r) => r.seq > afterSeq));
  }

  getMeta(streamId: string): Promise<StreamMeta | null> {
    return Promise.resolve(this.streams.get(streamId)?.meta ?? null);
  }

  finalize(streamId: string, status: "complete" | "error" | "cancelled"): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) return Promise.resolve();
    entry.meta.status = status;
    entry.meta.updatedAt = Date.now();
    return Promise.resolve();
  }

  listActive(conversationId: string): Promise<StreamMeta[]> {
    const ids = this.convStreams.get(conversationId) ?? [];
    return Promise.resolve(
      ids
        .map((id) => this.streams.get(id)?.meta)
        .filter((m): m is StreamMeta => !!m && m.status === "active"),
    );
  }

  listOrphaned(): Promise<StreamMeta[]> {
    return Promise.resolve([]);
  }

  deleteStream(streamId: string): Promise<void> {
    this.streams.delete(streamId);
    return Promise.resolve();
  }

  listConvStreams(conversationId: string): Promise<string[]> {
    return Promise.resolve(this.convStreams.get(conversationId) ?? []);
  }
}
