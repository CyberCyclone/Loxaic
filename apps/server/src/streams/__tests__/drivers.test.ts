import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { MemoryStreamLogDriver } from "../memory.ts";
import { RedisStreamLogDriver } from "../redis.ts";
import type { StreamLogDriver } from "../types.ts";

let seq = 0;
const freshId = (label: string) => `test-${label}-${String(Date.now())}-${String(seq++)}`;

/**
 * One contract, run against every driver. Both must agree on everything a
 * caller (broker, authz, recovery) actually depends on — the one deliberate
 * divergence (memory's `listOrphaned()` always `[]`, since nothing survives
 * a process crash by construction) is exercised separately, not here.
 */
function driverContract(label: string, driver: StreamLogDriver) {
  describe(`StreamLogDriver contract: ${label}`, () => {
    it("assigns contiguous seqs starting at 1, across multiple appends", async () => {
      const streamId = freshId(label);
      await driver.createStream({
        streamId,
        conversationId: freshId("conv"),
        userId: "u1",
        surface: "chat",
        incognito: false,
        createdAt: Date.now(),
      });
      const r1 = await driver.append(streamId, [{ kind: "text.delta", message_id: "m1", text: "a" }]);
      const r2 = await driver.append(streamId, [
        { kind: "text.delta", message_id: "m1", text: "b" },
        { kind: "text.delta", message_id: "m1", text: "c" },
      ]);
      expect(r1.map((r) => r.seq)).toEqual([1]);
      expect(r2.map((r) => r.seq)).toEqual([2, 3]);
    });

    it("readFrom(afterSeq) returns only later records, in seq order", async () => {
      const streamId = freshId(label);
      await driver.createStream({
        streamId,
        conversationId: freshId("conv"),
        userId: "u1",
        surface: "chat",
        incognito: false,
        createdAt: Date.now(),
      });
      await driver.append(streamId, [
        { kind: "text.delta", message_id: "m1", text: "a" },
        { kind: "text.delta", message_id: "m1", text: "b" },
        { kind: "text.delta", message_id: "m1", text: "c" },
      ]);
      const fromZero = await driver.readFrom(streamId, 0);
      const fromOne = await driver.readFrom(streamId, 1);
      expect(fromZero.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(fromOne.map((r) => r.seq)).toEqual([2, 3]);
    });

    it("getMeta reflects lastSeq/status; finalize removes it from listActive", async () => {
      const streamId = freshId(label);
      const conversationId = freshId("conv");
      await driver.createStream({
        streamId,
        conversationId,
        userId: "u1",
        surface: "chat",
        incognito: false,
        createdAt: Date.now(),
      });
      await driver.append(streamId, [{ kind: "text.delta", message_id: "m1", text: "a" }]);

      let meta = await driver.getMeta(streamId);
      expect(meta?.status).toBe("active");
      expect(meta?.lastSeq).toBe(1);

      let active = await driver.listActive(conversationId);
      expect(active.map((m) => m.streamId)).toContain(streamId);

      await driver.finalize(streamId, "complete");

      meta = await driver.getMeta(streamId);
      expect(meta?.status).toBe("complete");

      active = await driver.listActive(conversationId);
      expect(active.map((m) => m.streamId)).not.toContain(streamId);
    });

    it("a finalized stream never reappears in listOrphaned", async () => {
      const streamId = freshId(label);
      await driver.createStream({
        streamId,
        conversationId: freshId("conv"),
        userId: "u1",
        surface: "chat",
        incognito: false,
        createdAt: Date.now(),
      });
      await driver.finalize(streamId, "error");
      const orphaned = await driver.listOrphaned();
      expect(orphaned.map((m) => m.streamId)).not.toContain(streamId);
    });

    it("deleteStream removes the stream from getMeta and readFrom", async () => {
      const streamId = freshId(label);
      await driver.createStream({
        streamId,
        conversationId: freshId("conv"),
        userId: "u1",
        surface: "chat",
        incognito: false,
        createdAt: Date.now(),
      });
      await driver.append(streamId, [{ kind: "text.delta", message_id: "m1", text: "a" }]);
      await driver.deleteStream(streamId);
      expect(await driver.getMeta(streamId)).toBeNull();
      expect(await driver.readFrom(streamId, 0)).toEqual([]);
    });

    it("ephemeral conv registry round-trips and listConvStreams tracks run ids in creation order", async () => {
      const convId = freshId("econv");
      expect(await driver.getEphemeralConv(convId)).toBeNull();

      await driver.putEphemeralConv({ id: convId, ownerId: "u1", title: "hi", kind: "chat", createdAt: Date.now() });
      const conv = await driver.getEphemeralConv(convId);
      expect(conv?.ownerId).toBe("u1");

      const run1 = freshId("run");
      const run2 = freshId("run");
      await driver.createStream({
        streamId: run1,
        conversationId: convId,
        userId: "u1",
        surface: "chat",
        incognito: true,
        createdAt: Date.now(),
      });
      await driver.createStream({
        streamId: run2,
        conversationId: convId,
        userId: "u1",
        surface: "chat",
        incognito: true,
        createdAt: Date.now(),
      });

      expect(await driver.listConvStreams(convId)).toEqual([run1, run2]);
      await expect(driver.touchEphemeralConv(convId)).resolves.not.toThrow();
    });
  });
}

driverContract("memory", new MemoryStreamLogDriver(86400));

const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: Redis | null = null;

try {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  await probe.connect();
  await probe.ping();
  redis = probe;
} catch {
  redis = null;
}

if (redis) {
  driverContract("redis", new RedisStreamLogDriver(redis, 86400));
} else {
  describe.skip(`StreamLogDriver contract: redis (skipped — no reachable Redis at ${redisUrl})`, () => {
    it("skipped", () => undefined);
  });
}

afterAll(async () => {
  await redis?.quit();
});
