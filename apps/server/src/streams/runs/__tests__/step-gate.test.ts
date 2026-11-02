import { describe, expect, it } from "vitest";
import { LIMITS_ON, type RunLimits } from "@loxaic/types";
import { LoopDetector, loopDetectorOptions } from "../loop-detector.ts";
import { checkinWithdrawn, StepGate } from "../step-gate.ts";

const MAX = 5;
const gate = () => new StepGate(new LoopDetector(loopDetectorOptions("normal")), MAX);
const stepLimitOff: RunLimits = { ...LIMITS_ON, stepLimitOff: true };
const loopCheckOff: RunLimits = { ...LIMITS_ON, loopCheckOff: true };

describe("StepGate", () => {
  it("with every limit on, asks at the window's end and when a step repeats", () => {
    const g = gate();
    expect(g.afterStep("a", 4, 5, LIMITS_ON).reason).toBeNull();
    expect(g.afterStep("b", 5, 5, LIMITS_ON).reason).toBe("budget");

    const h = gate();
    h.afterStep("a", 1, 100, LIMITS_ON);
    h.afterStep("a", 2, 100, LIMITS_ON);
    const third = h.afterStep("a", 3, 100, LIMITS_ON);
    expect(third.reason).toBe("loop");
    expect(third.hit?.unit).toEqual(["a"]);
  });

  it("never asks about the budget with the step limit off, and a repeat still asks", () => {
    const g = gate();
    expect(g.afterStep("a", 50, 5, stepLimitOff).reason).toBeNull();
    expect(g.afterStep("b", 51, 5, stepLimitOff).reason).toBeNull();

    const h = gate();
    h.afterStep("a", 1, 1, stepLimitOff);
    h.afterStep("a", 2, 1, stepLimitOff);
    expect(h.afterStep("a", 3, 1, stepLimitOff).reason).toBe("loop");
  });

  it("slides the window while the step limit is off, so turning it back on grants a full one", () => {
    const g = gate();
    const off = g.afterStep("a", 40, 5, stepLimitOff);
    expect(off.budgetEnd).toBe(40 + MAX);
    // Back on at the very next step: nothing owed, and the window ends MAX on.
    expect(g.afterStep("b", 41, off.budgetEnd, LIMITS_ON)).toMatchObject({ reason: null, budgetEnd: 45 });
    expect(g.afterStep("c", 44, 45, LIMITS_ON).reason).toBeNull();
    expect(g.afterStep("d", 45, 45, LIMITS_ON).reason).toBe("budget");
  });

  it("never asks about a repeat with the loop check off, and the budget still asks", () => {
    const g = gate();
    for (let i = 1; i <= 4; i++) expect(g.afterStep("a", i, 5, loopCheckOff).reason).toBeNull();
    expect(g.afterStep("a", 5, 5, loopCheckOff).reason).toBe("budget");
  });

  it("forgets repeats from before the loop check went off, so turning it on asks nothing yet", () => {
    const g = gate();
    g.afterStep("a", 1, 100, LIMITS_ON);
    g.afterStep("a", 2, 100, LIMITS_ON);
    g.afterStep("a", 3, 100, loopCheckOff);
    g.afterStep("a", 4, 100, loopCheckOff);
    expect(g.afterStep("a", 5, 100, LIMITS_ON).reason).toBeNull();
    expect(g.afterStep("a", 6, 100, LIMITS_ON).reason).toBeNull();
    expect(g.afterStep("a", 7, 100, LIMITS_ON).reason).toBe("loop");
  });

  it("does not count repeats made while the loop check was off", () => {
    const g = gate();
    for (let i = 1; i <= 10; i++) g.afterStep("a", i, 100, loopCheckOff);
    expect(g.afterStep("b", 11, 100, LIMITS_ON).reason).toBeNull();
  });

  it("gives keep going a fresh window and a clean slate", () => {
    const g = gate();
    g.afterStep("a", 1, 100, LIMITS_ON);
    g.afterStep("a", 2, 100, LIMITS_ON);
    expect(g.keepGoing(2)).toBe(2 + MAX);
    expect(g.afterStep("a", 3, 7, LIMITS_ON).reason).toBeNull();
  });
});

describe("checkinWithdrawn", () => {
  it("is the switch behind the question, and only that one", () => {
    expect(checkinWithdrawn("budget", stepLimitOff)).toBe(true);
    expect(checkinWithdrawn("budget", loopCheckOff)).toBe(false);
    expect(checkinWithdrawn("loop", loopCheckOff)).toBe(true);
    expect(checkinWithdrawn("loop", stepLimitOff)).toBe(false);
    expect(checkinWithdrawn("budget", LIMITS_ON)).toBe(false);
  });
});
