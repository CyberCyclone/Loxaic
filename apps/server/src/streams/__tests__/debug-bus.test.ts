import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@shannon/types";
import {
  capString,
  createDebugSubscriptions,
  createLineBatcher,
  createModelDebugTap,
  DEBUG_PAYLOAD_CAP,
  hasDebugSubscribers,
  publishDebug,
  subscribeDebug,
} from "../debug-bus.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects the debug payloads delivered to one subscriber. */
function collector() {
  const seen: ServerMessage[] = [];
  return { seen, fn: (msg: ServerMessage) => seen.push(msg) };
}

describe("debug bus pub/sub", () => {
  it("delivers to subscribers and stops after unsubscribe", () => {
    const conv = `conv-${Math.random()}`;
    const c = collector();
    expect(hasDebugSubscribers(conv)).toBe(false);

    const off = subscribeDebug(conv, c.fn);
    expect(hasDebugSubscribers(conv)).toBe(true);

    publishDebug(conv, { channel: "model.raw", stream_id: "s1", lines: ["data: hi"] });
    expect(c.seen).toHaveLength(1);
    expect(c.seen[0]).toMatchObject({ type: "debug.event", conversation_id: conv });
    expect(typeof (c.seen[0] as { ts: number }).ts).toBe("number");

    off();
    expect(hasDebugSubscribers(conv)).toBe(false);
    publishDebug(conv, { channel: "model.raw", stream_id: "s1", lines: ["data: gone"] });
    expect(c.seen).toHaveLength(1);
  });

  it("never leaks across conversations", () => {
    const a = `conv-a-${Math.random()}`;
    const b = `conv-b-${Math.random()}`;
    const ca = collector();
    const cb = collector();
    const offA = subscribeDebug(a, ca.fn);
    const offB = subscribeDebug(b, cb.fn);

    publishDebug(a, { channel: "model.raw", stream_id: "s", lines: ["for-a"] });
    expect(ca.seen).toHaveLength(1);
    expect(cb.seen).toHaveLength(0);

    offA();
    offB();
  });
});

describe("capString", () => {
  it("passes short strings through untouched", () => {
    expect(capString("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("truncates at the byte cap and flags it", () => {
    const { text, truncated } = capString("x".repeat(DEBUG_PAYLOAD_CAP + 500));
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEBUG_PAYLOAD_CAP);
  });
});

describe("line batcher", () => {
  it("flushes once the line count is reached", () => {
    const batches: string[][] = [];
    const b = createLineBatcher((lines) => batches.push(lines), { maxLines: 3, maxMs: 10_000 });
    b.push("1");
    b.push("2");
    expect(batches).toHaveLength(0);
    b.push("3");
    expect(batches).toEqual([["1", "2", "3"]]);
  });

  it("flushes on the timer when the count is never reached", async () => {
    const batches: string[][] = [];
    const b = createLineBatcher((lines) => batches.push(lines), { maxLines: 100, maxMs: 20 });
    b.push("only");
    expect(batches).toHaveLength(0);
    await sleep(60);
    expect(batches).toEqual([["only"]]);
  });

  it("flushes the remainder explicitly and is a no-op when empty", () => {
    const batches: string[][] = [];
    const b = createLineBatcher((lines) => batches.push(lines), { maxLines: 100, maxMs: 10_000 });
    b.push("tail");
    b.flush();
    b.flush();
    expect(batches).toEqual([["tail"]]);
  });
});

describe("createModelDebugTap", () => {
  it("publishes nothing when nobody is subscribed", () => {
    const conv = `conv-quiet-${Math.random()}`;
    const c = collector();
    const tap = createModelDebugTap({ conversationId: conv, streamId: "s", model: "m" });
    tap.onRequest({ model: "m", messages: [] });
    tap.onRawLine("data: {}");
    tap.done({ finishReason: "stop", durationMs: 5 });
    tap.close();
    expect(c.seen).toHaveLength(0);
  });

  it("redacts secrets out of the request body and caps it", () => {
    const conv = `conv-redact-${Math.random()}`;
    const c = collector();
    const off = subscribeDebug(conv, c.fn);
    const tap = createModelDebugTap({
      conversationId: conv,
      streamId: "s",
      model: "m",
      secrets: () => ({ BRAVE_API_KEY: "BSA-super-secret" }),
      redact: (text, secrets) =>
        Object.values(secrets).reduce((acc, v) => acc.split(v).join("[redacted]"), text),
    });

    tap.onRequest({ messages: [{ role: "tool", content: "leaked BSA-super-secret here" }] });
    off();

    const body = (c.seen[0] as { event: { body: string } }).event.body;
    expect(body).not.toContain("BSA-super-secret");
    expect(body).toContain("[redacted]");
  });

  it("emits raw lines batched and a done event with timing", async () => {
    const conv = `conv-flow-${Math.random()}`;
    const c = collector();
    const off = subscribeDebug(conv, c.fn);
    const tap = createModelDebugTap({ conversationId: conv, streamId: "s1", model: "m" });

    tap.onRawLine("data: one");
    tap.onRawLine("data: two");
    tap.done({ finishReason: "stop", durationMs: 42 });
    off();

    const channels = c.seen.map((m) => (m as { event: { channel: string } }).event.channel);
    expect(channels).toEqual(["model.raw", "model.done"]);
    expect((c.seen[0] as { event: { lines: string[] } }).event.lines).toEqual(["data: one", "data: two"]);
    expect(c.seen[1]).toMatchObject({ event: { channel: "model.done", duration_ms: 42, finish_reason: "stop" } });
  });
});

describe("createDebugSubscriptions", () => {
  it("replaces a duplicate subscription instead of doubling delivery", () => {
    const conv = `conv-dup-${Math.random()}`;
    const c = collector();
    const subs = createDebugSubscriptions(c.fn);
    subs.subscribe(conv);
    subs.subscribe(conv);

    publishDebug(conv, { channel: "model.raw", stream_id: "s", lines: ["once"] });
    expect(c.seen).toHaveLength(1);

    subs.close();
    expect(hasDebugSubscribers(conv)).toBe(false);
  });

  it("releases every subscription on close", () => {
    const a = `conv-c1-${Math.random()}`;
    const b = `conv-c2-${Math.random()}`;
    const c = collector();
    const subs = createDebugSubscriptions(c.fn);
    subs.subscribe(a);
    subs.subscribe(b);
    subs.close();
    expect(hasDebugSubscribers(a)).toBe(false);
    expect(hasDebugSubscribers(b)).toBe(false);
  });
});
