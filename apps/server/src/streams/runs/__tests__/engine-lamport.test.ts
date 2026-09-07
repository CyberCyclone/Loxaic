import { describe, expect, it } from "vitest";
import { monotonicLamport } from "../engine.ts";

/**
 * Pure unit test for the fix behind "a mock scenario's steps replay
 * identically too" in prompt-prefix.test.ts: two of a run's own messages
 * inserted in the same millisecond used to take the same `Date.now()`
 * lamport, and `loadHistory`'s `ORDER BY lamport, createdAt` broke the tie
 * arbitrarily rather than by insertion order — a real prompt-prefix break the
 * first time it landed the wrong way. `runToolLoop` threads every insert
 * through this function instead of calling `Date.now()` directly.
 */
describe("monotonicLamport", () => {
  it("returns `now` when it already exceeds the previous value", () => {
    expect(monotonicLamport(1000, 2000)).toBe(2000);
  });

  it("advances by exactly one past the previous value when `now` has not moved", () => {
    // The exact collision this exists for: two inserts in the same
    // millisecond must still produce strictly increasing values.
    expect(monotonicLamport(1000, 1000)).toBe(1001);
    expect(monotonicLamport(1001, 1000)).toBe(1002);
  });

  it("advances by exactly one when the clock goes backwards", () => {
    // A leap-second adjustment or a clock correction must not be able to
    // reissue a lamport value a later message already used.
    expect(monotonicLamport(1000, 500)).toBe(1001);
  });

  it("stays strictly increasing across a run of same-millisecond inserts", () => {
    let last = 0;
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      last = monotonicLamport(last, 1_700_000_000_000); // frozen clock
      values.push(last);
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});
