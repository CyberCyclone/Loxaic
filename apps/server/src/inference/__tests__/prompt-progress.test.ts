import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";

process.env.MCP_ENCRYPTION_KEY ??= "prompt-progress-test-key";

import { db, eq } from "@loxaic/db";
import { inferenceProviders, user } from "@loxaic/db/schema";
import type { PromptProgress } from "@loxaic/types";
import { __resetModelCachesForTest, modelRunInfo } from "../models.ts";
import { parsePromptProgress, remainingMs } from "../prompt-progress.ts";
import { streamCompletion, type StreamEvent } from "../provider.ts";
import { __resetProviderCacheForTest, createProvider } from "../providers.ts";
import { startMockOpenAi, type MockOpenAi } from "./mock-openai-server.ts";

describe("parsePromptProgress", () => {
  it("maps llama.cpp's four numbers", () => {
    expect(parsePromptProgress({ total: 1000, cache: 200, processed: 600, time_ms: 100 })).toEqual({
      total_tokens: 1000,
      cached_tokens: 200,
      processed_tokens: 600,
      elapsed_ms: 100,
      // 400 evaluated in 100 ms; 400 left.
      remaining_ms: 100,
    });
  });

  it.each([
    ["not an object", "50%"],
    ["null", null],
    ["a missing field", { total: 10, cache: 0, processed: 5 }],
    ["a string count", { total: "10", cache: 0, processed: 5, time_ms: 1 }],
    ["a negative count", { total: 10, cache: -1, processed: 5, time_ms: 1 }],
    ["NaN", { total: Number.NaN, cache: 0, processed: 5, time_ms: 1 }],
    ["an empty prompt", { total: 0, cache: 0, processed: 0, time_ms: 0 }],
  ])("refuses %s rather than throwing", (_label, raw) => {
    expect(parsePromptProgress(raw)).toBeNull();
  });

  it("clamps figures that disagree with each other", () => {
    expect(parsePromptProgress({ total: 100, cache: 500, processed: 900, time_ms: 1 })).toMatchObject({
      processed_tokens: 100,
      cached_tokens: 100,
    });
  });
});

describe("remainingMs", () => {
  const p = (processed: number, cache: number, elapsed: number): PromptProgress => ({
    total_tokens: 10_000,
    cached_tokens: cache,
    processed_tokens: processed,
    elapsed_ms: elapsed,
    remaining_ms: null,
  });

  it("has no rate until enough is evaluated to call it one", () => {
    expect(remainingMs(p(255, 0, 1_000))).toBeNull();
    expect(remainingMs(p(9_000, 8_800, 1_000))).toBeNull();
    expect(remainingMs(p(1_000, 0, 0))).toBeNull();
  });

  it("has no answer once nothing is left — not zero, which reads as a second of work", () => {
    expect(remainingMs(p(10_000, 0, 5_000))).toBeNull();
    expect(parsePromptProgress({ total: 1000, cache: 200, processed: 1000, time_ms: 200 })?.remaining_ms).toBeNull();
  });

  it("divides only what was evaluated, so a cache hit is not speed", () => {
    // 1,000 evaluated in 2 s beyond an 8,000-token cache: 500 tok/s, 1,000 left.
    expect(remainingMs(p(9_000, 8_000, 2_000))).toBe(2_000);
  });
});

/**
 * Over the wire, against a backend that behaves like llama.cpp: asked with
 * `return_progress`, it streams `prompt_progress` on content-less chunks
 * before the reply. Real HTTP, because what matters is the request body and
 * how our parser reads chunks it has never been sent before.
 */
describe("progress through a live stream", () => {
  const adminId = `test-progress-${uuid()}`;
  let llama: MockOpenAi;
  let hosted: MockOpenAi;

  async function provider(baseUrl: string, input: Record<string, unknown> = {}) {
    return createProvider({ name: `P ${uuid().slice(0, 8)}`, baseUrl, ...input }, adminId);
  }

  async function run(model: string, reportProgress: boolean) {
    const events: StreamEvent[] = [];
    for await (const ev of streamCompletion(model, [{ role: "user", content: "hello" }], { reportProgress })) {
      events.push(ev);
    }
    return events;
  }

  beforeAll(async () => {
    llama = await startMockOpenAi({ nCtx: 8192, progress: true, reply: "Hi." });
    hosted = await startMockOpenAi({ progress: true, reply: "Hi." });
    await db.insert(user).values({
      id: adminId,
      name: "Progress Test Admin",
      email: `${adminId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return async () => {
      await db.delete(inferenceProviders).where(eq(inferenceProviders.createdBy, adminId));
      await db.delete(user).where(eq(user.id, adminId));
      await llama.stop();
      await hosted.stop();
    };
  });

  afterEach(() => {
    llama.requests.length = 0;
    hosted.requests.length = 0;
    __resetProviderCacheForTest();
    __resetModelCachesForTest();
  });

  it("asks, and yields the valid reports before any output", async () => {
    const row = await provider(llama.apiBase);
    const events = await run(`${row.slug}::mock-remote-model`, true);

    expect(llama.completions[0].body.return_progress).toBe(true);
    const kinds = events.map((e) => e.type);
    // Three good reports (the malformed one dropped), then the reply.
    expect(kinds).toEqual(["progress", "progress", "progress", "delta", "done"]);
    const last = events[2] as Extract<StreamEvent, { type: "progress" }>;
    expect(last.progress).toMatchObject({ total_tokens: 1000, cached_tokens: 200, processed_tokens: 1000 });
    // The empty `content: null` deltas on the progress chunks are not output.
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { content: string }).content).join("")).toBe("Hi.");
  });

  it("does not ask unless told to — and the backend then sends none", async () => {
    const row = await provider(llama.apiBase);
    const events = await run(`${row.slug}::mock-remote-model`, false);
    expect(llama.completions[0].body).not.toHaveProperty("return_progress");
    expect(events.some((e) => e.type === "progress")).toBe(false);
  });

  it("never sends the field to a named hosted API, whatever the caller says", async () => {
    // OpenAI answers an unknown request field with a 400; the preset check is
    // the lock behind the engine's own gate.
    const row = await provider(hosted.apiBase, { preset: "openai" });
    await run(`${row.slug}::mock-remote-model`, true);
    expect(hosted.completions[0].body).not.toHaveProperty("return_progress");
  });

  it("gates on the backend identifying itself, not on the missing preset", async () => {
    // A hand-entered provider pointed at a hosted API has no preset either.
    // Only a backend reporting an allocated window (llama.cpp's /props) is
    // a local runtime that will not refuse the field.
    const local = await provider(llama.apiBase);
    const anon = await provider(hosted.apiBase);
    expect((await modelRunInfo(`${local.slug}::mock-remote-model`))?.nativeRuntime).toBe(true);
    expect((await modelRunInfo(`${anon.slug}::mock-remote-model`))?.nativeRuntime).toBe(false);
  });
});
