import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_MIN_MESSAGES,
  AUTO_COMPACT_THRESHOLD,
  CANNOT_FIT_REASON,
  fillDecision,
  replyReserveTokens,
  type FillInput,
} from "../auto-compact.ts";

/**
 * What a full conversation gets: nothing yet, a larger context, a compaction,
 * or an honest stop.
 *
 * Worth pinning precisely because its failure mode is silence: a predicate
 * that never fires looks identical to one that works, right up until a
 * conversation gets long enough to matter — which is exactly when nobody is
 * watching it.
 */
describe("fillDecision", () => {
  const WINDOW = 100_000;
  const over = Math.ceil(WINDOW * AUTO_COMPACT_THRESHOLD);
  const under = over - 1;
  const enough = AUTO_COMPACT_MIN_MESSAGES;
  const base: FillInput = {
    estimatedTokens: over,
    windowTokens: WINDOW,
    messagesSinceSummary: enough,
    stages: null,
    phase: "mid_run",
  };
  const decide = (patch: Partial<FillInput>) => fillDecision({ ...base, ...patch });

  it("is enabled by default", () => {
    // If this ever reads 0, every assertion below passes vacuously.
    expect(AUTO_COMPACT_THRESHOLD).toBeGreaterThan(0);
    expect(AUTO_COMPACT_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("compacts once the prompt crosses the threshold, in both phases", () => {
    expect(decide({})).toEqual({ action: "compact" });
    expect(decide({ phase: "after_turn" })).toEqual({ action: "compact" });
  });

  it("does nothing below the threshold", () => {
    expect(decide({ estimatedTokens: under })).toEqual({ action: "none" });
    expect(decide({ estimatedTokens: under, messagesSinceSummary: 400 })).toEqual({ action: "none" });
  });

  it("leaves headroom — the line is below the window, not at it", () => {
    expect(over).toBeLessThan(WINDOW);
  });

  it("does nothing when the window or the size is unknown", () => {
    expect(decide({ windowTokens: null, estimatedTokens: 10_000_000 })).toEqual({ action: "none" });
    expect(decide({ windowTokens: 0, estimatedTokens: 10_000_000 })).toEqual({ action: "none" });
    expect(decide({ estimatedTokens: null })).toEqual({ action: "none" });
  });

  it("extends a model set to extend, one stage at a time, until none is left", () => {
    const extend = (active: number) => decide({ stages: { whenFull: "extend", active, count: 2 } });
    expect(extend(0)).toEqual({ action: "extend", target: 1 });
    expect(extend(1)).toEqual({ action: "extend", target: 2 });
    // At the last stage it compacts, like any other model.
    expect(extend(2)).toEqual({ action: "compact" });
  });

  it("extends a short thread too — the floor is compaction's, not extension's", () => {
    expect(decide({ stages: { whenFull: "extend", active: 0, count: 1 }, messagesSinceSummary: 1 })).toEqual({
      action: "extend",
      target: 1,
    });
  });

  it("compacts a model set to compact, whatever stages it has", () => {
    expect(decide({ stages: { whenFull: "compact", active: 0, count: 3 } })).toEqual({ action: "compact" });
  });

  it("will not compact a thread with too little in it", () => {
    // The anti-thrash guard: after a compaction the replay restarts at zero,
    // so without it a conversation whose summary alone sits near the line
    // would re-compact on every request to save nothing.
    expect(decide({ messagesSinceSummary: enough - 1, phase: "after_turn" })).toEqual({ action: "none" });
  });

  it("before a request, below the floor, sends one that still fits", () => {
    const fits = WINDOW - replyReserveTokens(WINDOW);
    expect(decide({ messagesSinceSummary: enough - 1, estimatedTokens: fits })).toEqual({ action: "none" });
  });

  it("before a request, compacts one that cannot fit even below the floor — once", () => {
    // The floor stops a summary being redone for nothing; it never sends a
    // request that cannot fit. One compaction per run, though: a run that has
    // compacted and still does not fit would only compact again.
    const over = WINDOW - replyReserveTokens(WINDOW) + 1;
    expect(decide({ messagesSinceSummary: 2, estimatedTokens: over })).toEqual({ action: "compact" });
    expect(decide({ messagesSinceSummary: 2, estimatedTokens: over, compactedThisRun: true })).toEqual({
      action: "cannot",
      reason: CANNOT_FIT_REASON,
    });
  });

  it("refuses a single message too large for the window: there is nothing else to summarise", () => {
    const over = WINDOW - replyReserveTokens(WINDOW) + 1;
    expect(decide({ messagesSinceSummary: 1, estimatedTokens: over })).toEqual({ action: "cannot", reason: CANNOT_FIT_REASON });
  });

  it("keeps a reply's worth of room, never more than 1K tokens", () => {
    expect(replyReserveTokens(4096)).toBe(204);
    expect(replyReserveTokens(262_144)).toBe(1024);
  });
});
