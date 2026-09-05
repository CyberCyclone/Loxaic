import type { Redis } from "ioredis";
import type { StreamEventKind, StreamStatus } from "@loxaic/types";
import type { StreamLogDriver, StreamMeta, StreamRecord } from "./types.ts";

const P = "loxaic";
const streamKey = (id: string) => `${P}:stream:${id}`;
const metaKey = (id: string) => `${P}:stream:${id}:meta`;
const convActiveKey = (convId: string) => `${P}:conv:${convId}:active`;
const convRunsKey = (convId: string) => `${P}:conv:${convId}:runs`;
const globalActiveKey = `${P}:streams:active`;

function metaFromHash(h: Record<string, string>): StreamMeta | null {
  if (!h.streamId) return null;
  return {
    streamId: h.streamId,
    conversationId: h.conversationId,
    userId: h.userId,
    surface: h.surface as "chat" | "agent",
    status: h.status as StreamStatus,
    lastSeq: Number(h.lastSeq) || 0,
    createdAt: Number(h.createdAt) || 0,
    updatedAt: Number(h.updatedAt) || 0,
  };
}

function metaToHash(m: StreamMeta): Record<string, string | number> {
  return {
    streamId: m.streamId,
    conversationId: m.conversationId,
    userId: m.userId,
    surface: m.surface,
    status: m.status,
    lastSeq: m.lastSeq,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/**
 * Redis Streams driver — durability + catch-up for the log; live fan-out is
 * the StreamBroker's job (this driver is never read via XREAD BLOCK). Our
 * own contiguous `seq` lives inside each entry's JSON payload; Redis' own
 * stream-entry IDs (ms-timestamp based) are ignored for ordering.
 *
 * Every stream/meta/registry key carries the same idle TTL (`ttlSeconds`),
 * refreshed on activity — a safety net so nothing lingers forever if
 * `finalize` is never reached for some reason (orphan recovery is the
 * primary cleanup path for that; the TTL is the backstop).
 */
export class RedisStreamLogDriver implements StreamLogDriver {
  constructor(
    private redis: Redis,
    private ttlSeconds: number,
  ) {}

  async createStream(meta: Omit<StreamMeta, "lastSeq" | "status" | "updatedAt">): Promise<StreamMeta> {
    const now = Date.now();
    const full: StreamMeta = { ...meta, status: "active", lastSeq: 0, updatedAt: now };
    const pipeline = this.redis.pipeline();
    pipeline.hset(metaKey(meta.streamId), metaToHash(full));
    pipeline.expire(metaKey(meta.streamId), this.ttlSeconds);
    pipeline.sadd(convActiveKey(meta.conversationId), meta.streamId);
    pipeline.expire(convActiveKey(meta.conversationId), this.ttlSeconds);
    pipeline.sadd(globalActiveKey, meta.streamId);
    pipeline.rpush(convRunsKey(meta.conversationId), meta.streamId);
    pipeline.expire(convRunsKey(meta.conversationId), this.ttlSeconds);
    await pipeline.exec();
    return full;
  }

  async append(streamId: string, events: StreamEventKind[]): Promise<StreamRecord[]> {
    if (events.length === 0) return [];
    const now = Date.now();
    const newLastSeq = await this.redis.hincrby(metaKey(streamId), "lastSeq", events.length);
    const startSeq = newLastSeq - events.length + 1;
    const records: StreamRecord[] = events.map((event, i) => ({ seq: startSeq + i, ts: now, event }));

    const pipeline = this.redis.pipeline();
    for (const r of records) pipeline.xadd(streamKey(streamId), "*", "d", JSON.stringify(r));
    pipeline.expire(streamKey(streamId), this.ttlSeconds);
    pipeline.hset(metaKey(streamId), "updatedAt", now);
    pipeline.expire(metaKey(streamId), this.ttlSeconds);
    await pipeline.exec();
    return records;
  }

  async readFrom(streamId: string, afterSeq: number): Promise<StreamRecord[]> {
    const entries = await this.redis.xrange(streamKey(streamId), "-", "+");
    const out: StreamRecord[] = [];
    for (const [, fields] of entries) {
      const idx = fields.indexOf("d");
      if (idx === -1) continue;
      try {
        const record = JSON.parse(fields[idx + 1]) as StreamRecord;
        if (record.seq > afterSeq) out.push(record);
      } catch {
        // Skip a malformed entry rather than fail the whole catch-up.
      }
    }
    return out;
  }

  async getMeta(streamId: string): Promise<StreamMeta | null> {
    const h = await this.redis.hgetall(metaKey(streamId));
    return metaFromHash(h);
  }

  async finalize(streamId: string, status: "complete" | "error" | "cancelled"): Promise<void> {
    const meta = await this.getMeta(streamId);
    if (!meta) return;
    const pipeline = this.redis.pipeline();
    pipeline.hset(metaKey(streamId), "status", status, "updatedAt", Date.now());
    pipeline.expire(metaKey(streamId), this.ttlSeconds);
    pipeline.expire(streamKey(streamId), this.ttlSeconds);
    pipeline.srem(convActiveKey(meta.conversationId), streamId);
    pipeline.srem(globalActiveKey, streamId);
    await pipeline.exec();
  }

  async listActive(conversationId: string): Promise<StreamMeta[]> {
    const ids = await this.redis.smembers(convActiveKey(conversationId));
    const metas = await Promise.all(ids.map((id) => this.getMeta(id)));
    return metas.filter((m): m is StreamMeta => !!m && m.status === "active");
  }

  async listOrphaned(): Promise<StreamMeta[]> {
    const ids = await this.redis.smembers(globalActiveKey);
    const metas = await Promise.all(ids.map((id) => this.getMeta(id)));
    return metas.filter((m): m is StreamMeta => !!m);
  }

  async deleteStream(streamId: string): Promise<void> {
    const meta = await this.getMeta(streamId);
    const pipeline = this.redis.pipeline();
    pipeline.del(streamKey(streamId), metaKey(streamId));
    pipeline.srem(globalActiveKey, streamId);
    if (meta) pipeline.srem(convActiveKey(meta.conversationId), streamId);
    await pipeline.exec();
  }

  async listConvStreams(conversationId: string): Promise<string[]> {
    return this.redis.lrange(convRunsKey(conversationId), 0, -1);
  }
}
