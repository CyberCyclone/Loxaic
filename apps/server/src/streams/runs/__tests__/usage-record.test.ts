import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../../../inference/provider.ts";
import { turnDraftUsage, usageRecordValues } from "../usage-record.ts";

/**
 * The one builder both usage inserts go through. Its job is to never hand an
 * integer column a fraction: llama.cpp's timings are fractional milliseconds,
 * and one of them in `prompt_ms` failed every usage row on the beta — and a
 * twelve-minute compaction with it.
 */
const result = (over: Partial<CompletionResult> = {}): CompletionResult =>
  ({
    text: "",
    content: "",
    toolCalls: [],
    finishReason: "stop",
    ttftMs: 12.6,
    totalMs: 749_700.4,
    usage: { prompt_tokens: 235_432, completion_tokens: 806, total_tokens: 236_238 },
    timings: { prompt_ms: 749_609.667, predicted_ms: 20_512.25 },
    cachedTokens: 228_000,
    promptTps: 151.2,
    genTps: 39.3,
    ...over,
  }) as unknown as CompletionResult;

describe("usageRecordValues", () => {
  it("rounds every figure bound for an integer column", () => {
    const row = usageRecordValues({ userId: "u", conversationId: "c", messageId: "m", model: "x", result: result() });
    expect(row).toMatchObject({ promptMs: 749_610, predictMs: 20_512, ttftMs: 13, totalMs: 749_700, inputTokens: 235_432 });
    // Rates are `real` columns and keep their fractions.
    expect(row.promptTps).toBe(151.2);
  });

  it("keeps null as null — the backend said nothing, which is not zero", () => {
    const row = usageRecordValues({
      userId: "u", conversationId: "c", messageId: "m", model: "x",
      result: result({ timings: null, cachedTokens: null, ttftMs: null as unknown as number }),
    });
    expect(row.promptMs).toBeNull();
    expect(row.predictMs).toBeNull();
    expect(row.cachedTokens).toBeNull();
    expect(row.ttftMs).toBeNull();
  });

  it("records the reusable figure only when the caller measured one", () => {
    const base = { userId: "u", conversationId: "c", messageId: "m", model: "x", result: result() };
    expect("reusableTokens" in usageRecordValues(base)).toBe(false);
    expect(usageRecordValues({ ...base, reusableTokens: 1000.4 }).reusableTokens).toBe(1000);
  });

  it("records what an MTP head drafted and the model accepted, and null when nothing was drafted", () => {
    const base = { userId: "u", conversationId: "c", messageId: "m", model: "x" };
    const drafted = result({ timings: { prompt_ms: 1, predicted_ms: 1, draft_n: 132, draft_n_accepted: 99 } as never });
    expect(usageRecordValues({ ...base, result: drafted })).toMatchObject({ draftTokens: 132, draftAcceptedTokens: 99 });
    expect(turnDraftUsage(drafted)).toEqual({ draft_tokens: 132, draft_accepted_tokens: 99 });
    // Not speculated: null in the row and absent on the wire — never 0.
    expect(usageRecordValues({ ...base, result: result() })).toMatchObject({ draftTokens: null, draftAcceptedTokens: null });
    expect(turnDraftUsage(result())).toEqual({});
    expect(turnDraftUsage(result({ timings: null }))).toEqual({});
  });
});
