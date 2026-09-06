import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_MIN_MESSAGES,
  AUTO_COMPACT_THRESHOLD,
  shouldAutoCompact,
} from "../auto-compact.ts";

/**
 * The policy behind compacting without being asked.
 *
 * Worth pinning precisely because its failure mode is silence: a predicate
 * that never fires looks identical to one that works, right up until a
 * conversation gets long enough to matter — which is exactly when nobody is
 * watching it. The two guards below (an unknown window, and a floor on
 * message count) are each load-bearing in a different direction, so both are
 * asserted rather than assumed.
 */
describe("shouldAutoCompact", () => {
  const WINDOW = 100_000;
  const over = Math.ceil(WINDOW * AUTO_COMPACT_THRESHOLD);
  const under = over - 1;
  const enough = AUTO_COMPACT_MIN_MESSAGES;

  it("is enabled by default", () => {
    // If this ever reads 0, every assertion below passes vacuously.
    expect(AUTO_COMPACT_THRESHOLD).toBeGreaterThan(0);
    expect(AUTO_COMPACT_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("fires once the turn crosses the threshold", () => {
    expect(shouldAutoCompact({ usedTokens: over, windowTokens: WINDOW, historyMessages: enough })).toBe(true);
  });

  it("does not fire below the threshold", () => {
    expect(shouldAutoCompact({ usedTokens: under, windowTokens: WINDOW, historyMessages: enough })).toBe(false);
  });

  it("leaves headroom — the trigger point is below the window, not at it", () => {
    // The check runs after a turn finishes, so firing at 100% would mean the
    // turn that overflowed had already been sent.
    expect(over).toBeLessThan(WINDOW);
  });

  it("does nothing when the window is unknown", () => {
    // A backend that reports no window gives us no fraction to compare
    // against. Compacting on a guess would rewrite a conversation for no
    // established reason.
    expect(shouldAutoCompact({ usedTokens: 10_000_000, windowTokens: null, historyMessages: enough })).toBe(false);
    expect(shouldAutoCompact({ usedTokens: 10_000_000, windowTokens: 0, historyMessages: enough })).toBe(false);
  });

  it("will not compact a thread that has too little in it", () => {
    // The anti-thrash guard: after a compaction the replay restarts at zero,
    // so without this a conversation whose summary alone sits near the
    // threshold would re-compact every turn, burning a model call and a full
    // prompt re-evaluation each time to save nothing.
    expect(
      shouldAutoCompact({ usedTokens: WINDOW, windowTokens: WINDOW, historyMessages: enough - 1 }),
    ).toBe(false);
    expect(shouldAutoCompact({ usedTokens: WINDOW, windowTokens: WINDOW, historyMessages: enough })).toBe(true);
  });

  it("stays off for a conversation that is merely long, not full", () => {
    expect(shouldAutoCompact({ usedTokens: 1_000, windowTokens: WINDOW, historyMessages: 400 })).toBe(false);
  });
});
