/**
 * How long a run waits for a person, and what happens when nobody comes.
 *
 * Shared by the server (which enforces these) and the settings screen (which
 * offers them), so the two cannot disagree about a range or a default.
 *
 * Two waits, deliberately separate. A **step check-in** parks a run between
 * iterations to ask whether to carry on; an **approval** parks it mid-turn on
 * one tool call. They used to share a single `APPROVAL_TIMEOUT_MS`, which
 * meant a deployment could not make one patient without making the other
 * patient too — and an unanswered check-in is a much cheaper thing to wait on
 * than an unanswered approval, since nothing is mid-flight.
 */

/** The built-in window when neither the user nor the operator has chosen one.
 * Ten minutes rather than the old five: on a slow local backend a single turn
 * can take longer than five minutes on its own, so a person checking back
 * between turns would routinely miss the window. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The shortest window a user may choose.
 *
 * Not a product floor — nobody wants a five-second check-in — but the one that
 * makes the unattended path testable end to end: a spec has to wait the window
 * out, and a floor of minutes would put a real timeout beyond any e2e run.
 */
export const MIN_WAIT_TIMEOUT_MS = 5_000;

/**
 * The longest window anywhere, from any source.
 *
 * Also the hard ceiling for the adaptive floor. It sits well below Node's
 * `setTimeout` limit (2**31 - 1 ms, ~24.8 days), which is the one that matters
 * mechanically: past it Node silently reduces the delay to **1 ms**, so "set it
 * huge so it never expires" would expire every wait instantly.
 */
export const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Why a wait's deadline is what it is.
 *
 * `setting` — the user's chosen window (or the server default).
 * `adaptive` — stretched past that because this run's own model requests are
 * slow: nobody should be expected to answer faster than the model can take a
 * single step.
 */
export type TimeoutBasis = "setting" | "adaptive";

/**
 * How many consecutive unanswered check-ins may carry on by themselves before
 * the run wraps up with what it has.
 *
 * Each one grants another full step window of work with nobody watching, so the
 * ceiling is small on purpose: at a few minutes a step, even one extra window
 * of a hundred steps is hours.
 */
export const MAX_CHECKIN_AUTO_CONTINUES = 3;
export const DEFAULT_CHECKIN_AUTO_CONTINUES = 2;

/**
 * How eagerly the run notices it is repeating itself.
 *
 * `normal` asks after the same step three times, or a short cycle twice.
 * `relaxed` waits for five, or a cycle three times — for a model that
 * legitimately re-reads files. `off` never asks for this reason; the step
 * window still applies.
 */
export type LoopSensitivity = "off" | "relaxed" | "normal";
export const LOOP_SENSITIVITIES: readonly LoopSensitivity[] = ["off", "relaxed", "normal"];
export const DEFAULT_LOOP_SENSITIVITY: LoopSensitivity = "normal";

export function isLoopSensitivity(value: unknown): value is LoopSensitivity {
  return typeof value === "string" && (LOOP_SENSITIVITIES as readonly string[]).includes(value);
}
