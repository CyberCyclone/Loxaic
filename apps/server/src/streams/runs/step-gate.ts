/**
 * Whether a finished step earned a check-in, given what the conversation's
 * owner has turned off (`RunLimits`).
 *
 * Pure apart from the detector it is handed, so each rule can be asserted
 * directly; the engine owns the waiting. What a switch does is decided here and
 * read afresh every step, because either can change in the middle of a run:
 *
 * - **Loop check off:** the detector hears nothing, and starts clean when it is
 *   turned back on, so repeats from before cannot count towards a hit.
 * - **Step limit off:** the window slides with the run, so turning it back on
 *   grants one full window from there rather than a check-in on the spot.
 */
import type { CheckinReason, RunLimits } from "@loxaic/types";
import type { LoopDetector, LoopHit } from "./loop-detector.ts";

export interface StepVerdict {
  hit: LoopHit | null;
  reason: CheckinReason | null;
  /** The window's end from here on. */
  budgetEnd: number;
}

export class StepGate {
  private readonly detector: LoopDetector;
  private readonly maxIterations: number;
  private loopCheckWasOff = false;

  constructor(detector: LoopDetector, maxIterations: number) {
    this.detector = detector;
    this.maxIterations = maxIterations;
  }

  afterStep(iterationKey: string, iteration: number, budgetEnd: number, limits: RunLimits): StepVerdict {
    let hit: LoopHit | null = null;
    if (limits.loopCheckOff) {
      this.loopCheckWasOff = true;
    } else {
      if (this.loopCheckWasOff) this.detector.reset();
      this.loopCheckWasOff = false;
      hit = this.detector.push(iterationKey);
    }
    const end = limits.stepLimitOff ? iteration + this.maxIterations : budgetEnd;
    const reason: CheckinReason | null = hit ? "loop" : iteration >= end ? "budget" : null;
    return { hit, reason, budgetEnd: end };
  }

  /** "Keep going": a fresh window from this step, and no memory of the repeats
   * the person just waved through. */
  keepGoing(iteration: number): number {
    this.detector.reset();
    return iteration + this.maxIterations;
  }
}

/** Whether the switch behind a check-in has been turned off, which is the
 * person's answer to it: the run should not wait on a question they have said
 * they do not want asked. */
export function checkinWithdrawn(reason: CheckinReason, limits: RunLimits): boolean {
  return reason === "loop" ? limits.loopCheckOff : limits.stepLimitOff;
}
