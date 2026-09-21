import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../inference/provider.ts";
import { tallyChatMessages } from "../../../inference/context.ts";
import { __resetPrefillRatesForTest, recordPrefill } from "../../../inference/prefill-rate.ts";
import type { StreamEventKind } from "@loxaic/types";
import { promptProgressEmitter, promptStatsFor } from "../engine.ts";
import { StreamBroker } from "../../broker.ts";
import { MemoryStreamLogDriver } from "../../memory.ts";
import type { StreamRecord } from "../../types.ts";

const history: ChatMessage[] = [
  { role: "system", content: "s".repeat(4_000) },
  { role: "user", content: "u".repeat(8_000) },
];

function stats(overrides: Partial<Parameters<typeof promptStatsFor>[0]> = {}) {
  return promptStatsFor({
    messageId: "a1",
    model: "m",
    tally: tallyChatMessages(history),
    chatMessages: history,
    reuse: { tokens: null, sharedMessages: 0, previousMessages: 0 },
    windowTokens: 32_768,
    loadingModel: false,
    startedAt: 123,
    ...overrides,
  });
}

describe("promptStatsFor", () => {
  beforeEach(() => {
    __resetPrefillRatesForTest();
  });

  it("estimates a first request from characters, with no ETA and no reuse claim", () => {
    const s = stats();
    expect(s).toMatchObject({ est_basis: "estimate", reusable_tokens: null, eta_ms: null, window_tokens: 32_768, started_at: 123 });
    expect(s.prompt_tokens_est).toBe(3_000);
  });

  it("builds on the measured prefix, estimating only what was appended", () => {
    const appended: ChatMessage[] = [...history, { role: "user", content: "x".repeat(4_000) }];
    const s = stats({
      chatMessages: appended,
      tally: tallyChatMessages(appended),
      reuse: { tokens: 3_210, sharedMessages: 2, previousMessages: 2 },
    });
    expect(s.est_basis).toBe("measured_prefix");
    expect(s.reusable_tokens).toBe(3_210);
    expect(s.prompt_tokens_est).toBe(3_210 + 1_000);
  });

  it("reports a broken prefix as zero reusable — a measurement, not an unknown", () => {
    const s = stats({ reuse: { tokens: 0, sharedMessages: 1, previousMessages: 3 } });
    expect(s.reusable_tokens).toBe(0);
    expect(s.est_basis).toBe("estimate");
  });

  it("gives an ETA for the unreused part once there is a rate", () => {
    recordPrefill("m", { promptTps: 200, promptTokens: 0, exactReusableTokens: null, ttftMs: null, loadedModel: false });
    // 3,000 tokens, none reusable, at 200 tok/s.
    expect(stats().eta_ms).toBe(15_000);
    const appended: ChatMessage[] = [...history, { role: "user", content: "x".repeat(4_000) }];
    // Only the 1,000 appended tokens need evaluating.
    expect(
      stats({ chatMessages: appended, tally: tallyChatMessages(appended), reuse: { tokens: 3_000, sharedMessages: 2, previousMessages: 2 } }).eta_ms,
    ).toBe(5_000);
  });

  it("gives no ETA while the model is still loading", () => {
    recordPrefill("m", { promptTps: 200, promptTokens: 0, exactReusableTokens: null, ttftMs: null, loadedModel: false });
    expect(stats({ loadingModel: true }).eta_ms).toBeNull();
  });
});

describe("foldSnapshot carries prompt stats until output starts", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: Date.now(), event });
  const promptStats = {
    kind: "prompt.stats" as const,
    message_id: "a1",
    prompt_tokens_est: 83_700,
    est_basis: "estimate" as const,
    reusable_tokens: 0,
    window_tokens: 131_072,
    eta_ms: 420_000,
    started_at: 1,
  };

  it("is present while the prompt is being evaluated", () => {
    const { kind: _kind, ...rest } = promptStats;
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "message.start", message_id: "a1", author_type: "assistant", parent_id: null }),
      rec(2, promptStats),
    ]);
    expect(snapshot.prompt_stats).toEqual(rest);
  });

  it.each([
    ["the first text", { kind: "text.delta", message_id: "a1", text: "h" }],
    ["the first reasoning", { kind: "thinking.delta", message_id: "a1", text: "h" }],
    ["a tool call", { kind: "tool.call", message_id: "a1", call_id: "c", tool: "bash", args: {} }],
    ["the message ending", { kind: "message.end", message_id: "a1", status: "error" }],
  ] as [string, StreamRecord["event"]][])("is cleared by %s", (_label, event) => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "message.start", message_id: "a1", author_type: "assistant", parent_id: null }),
      rec(2, promptStats),
      rec(3, event),
    ]);
    expect(snapshot.prompt_stats).toBeUndefined();
  });
});

describe("promptProgressEmitter", () => {
  const base = stats();
  const at = (processed: number) => ({
    total_tokens: 1_000,
    cached_tokens: 0,
    processed_tokens: processed,
    elapsed_ms: 0,
    remaining_ms: null,
  });

  it("re-emits the request's stats with the progress merged in", () => {
    const out: StreamEventKind[] = [];
    promptProgressEmitter(base, (e) => out.push(e), () => 0)(at(100));
    expect(out).toEqual([{ kind: "prompt.stats", ...base, progress: at(100) }]);
  });

  it("sends the first report, then at most one a second, and always the last", () => {
    let now = 0;
    const out: StreamEventKind[] = [];
    const emit = promptProgressEmitter(base, (e) => out.push(e), () => now);
    emit(at(100)); // first: always
    now = 300;
    emit(at(200)); // too soon
    now = 999;
    emit(at(300)); // still too soon
    now = 1_000;
    emit(at(400)); // a second after the last sent
    now = 1_100;
    emit(at(1_000)); // complete: always, or the bar stalls short of full
    const sent = out.map((e) => (e.kind === "prompt.stats" ? e.progress?.processed_tokens : null));
    expect(sent).toEqual([100, 400, 1_000]);
  });

  it("forces the 100% report once — a backend stalled at 100% is throttled like any other", () => {
    // Reaching 100% and then not producing a token (a contended slot, a wedged
    // backend) keeps reporting `processed == total`. Each one is a persisted,
    // broadcast, flush-forcing event, for up to the hour-long request ceiling.
    let now = 0;
    const out: StreamEventKind[] = [];
    const emit = promptProgressEmitter(base, (e) => out.push(e), () => now);
    emit(at(500));
    for (now = 10; now <= 2_000; now += 10) emit(at(1_000));
    // The first, the forced 100% at t=10, then one a second: t=1010, t=2000 is
    // only 990 after that.
    expect(out).toHaveLength(3);
  });

  it("folds to the latest report, and still clears on the first output", () => {
    const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
    const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: 0, event });
    const start = rec(1, { kind: "message.start", message_id: "a1", author_type: "assistant", parent_id: null });
    const first = rec(2, { kind: "prompt.stats", ...base });
    const later = rec(3, { kind: "prompt.stats", ...base, progress: at(600) });
    expect(broker.foldSnapshot([start, first, later]).prompt_stats?.progress).toEqual(at(600));
    const out = rec(4, { kind: "text.delta", message_id: "a1", text: "h" });
    expect(broker.foldSnapshot([start, first, later, out]).prompt_stats).toBeUndefined();
  });
});
