import Redis from "ioredis";
import { StreamBroker } from "./broker.ts";
import { MemoryStreamLogDriver } from "./memory.ts";
import { RedisStreamLogDriver } from "./redis.ts";

const COALESCE_MS = Number(process.env.STREAM_COALESCE_MS) || 25;
const TTL_SECONDS = Number(process.env.STREAM_TTL_SECONDS) || 86400;

let broker: StreamBroker | null = null;

/**
 * Called once at boot, after migrations and before routes/WS handlers are
 * registered. `STREAM_BACKEND=redis` with an unreachable Redis fails loudly
 * here — there is no silent fallback to the memory driver, since that would
 * silently drop the durability guarantee stream resume depends on.
 */
export async function initStreamBroker(): Promise<StreamBroker> {
  const backend = process.env.STREAM_BACKEND ?? "memory";
  if (backend === "redis") {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    try {
      await redis.connect();
      await redis.ping();
    } catch (err) {
      throw new Error(`STREAM_BACKEND=redis but Redis is unreachable at ${url}: ${(err as Error).message}`);
    }
    broker = new StreamBroker(new RedisStreamLogDriver(redis, TTL_SECONDS), COALESCE_MS);
  } else {
    broker = new StreamBroker(new MemoryStreamLogDriver(TTL_SECONDS), COALESCE_MS);
  }
  return broker;
}

export function getStreamBroker(): StreamBroker {
  if (!broker) throw new Error("Stream broker not initialized — call initStreamBroker() at boot before this.");
  return broker;
}

export type { StreamProducer, StreamProducerMeta } from "./broker.ts";
export type { StreamLogDriver, StreamMeta, StreamRecord } from "./types.ts";
