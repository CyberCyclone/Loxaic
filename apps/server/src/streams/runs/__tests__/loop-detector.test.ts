import { describe, it, expect } from "vitest";
import { LoopDetector } from "../loop-detector.ts";

/** Feeds a sequence and returns the index of the first push that tripped, or
 * null. Written as "when did it first speak up", because a detector that fires
 * a step later than it should is as wrong as one that never fires. */
function firstHitAt(keys: string[]): number | null {
  const d = new LoopDetector();
  for (const [i, k] of keys.entries()) {
    if (d.push(k)) return i;
  }
  return null;
}

describe("LoopDetector", () => {
  it("fires on the same iteration three times running, not two", () => {
    // Two is a retry — a flaky command, a file that was not written yet.
    expect(firstHitAt(["A", "A"])).toBeNull();
    expect(firstHitAt(["A", "A", "A"])).toBe(2);
  });

  it("fires on a two-step cycle repeated twice", () => {
    expect(firstHitAt(["A", "B", "A"])).toBeNull();
    expect(firstHitAt(["A", "B", "A", "B"])).toBe(3);
  });

  it("fires on a three-step cycle repeated twice", () => {
    expect(firstHitAt(["A", "B", "C", "A", "B"])).toBeNull();
    expect(firstHitAt(["A", "B", "C", "A", "B", "C"])).toBe(5);
  });

  it("leaves genuine progress alone", () => {
    expect(firstHitAt(["A", "B", "C", "D", "E", "F", "G", "H"])).toBeNull();
    // A revisit is not a cycle: the run came back to A once, then moved on.
    expect(firstHitAt(["A", "B", "C", "A", "D", "E"])).toBeNull();
  });

  it("reports the repeating unit so the event can name it", () => {
    const d = new LoopDetector();
    d.push("A");
    d.push("B");
    d.push("A");
    const hit = d.push("B");
    expect(hit).toEqual({ unitLength: 2, repeats: 2, unit: ["A", "B"] });
  });

  it("re-arms on reset rather than switching off", () => {
    const d = new LoopDetector();
    d.push("A");
    d.push("A");
    expect(d.push("A")).not.toBeNull();
    d.reset();
    // The history is gone, so the next push cannot re-complete the old
    // pattern — otherwise "keep going" would be met with the same question
    // one iteration later.
    expect(d.push("A")).toBeNull();
    expect(d.push("A")).toBeNull();
    // ...but a fresh set of repeats still speaks up.
    expect(d.push("A")).not.toBeNull();
  });
});
