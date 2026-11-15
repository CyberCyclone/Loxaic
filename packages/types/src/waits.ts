/**
 * How long a run waits for a person to approve a tool call, and what happens
 * when nobody comes.
 *
 * Shared by the server (which enforces these) and the settings screen (which
 * offers them), so the two cannot disagree about a range or a default.
 */

/** The built-in window when neither the user nor the operator has chosen one.
 * Ten minutes rather than the old five: on a slow local backend a single turn
 * can take longer than five minutes on its own, so a person checking back
 * between turns would routinely miss the window. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The shortest window a user may choose.
 *
 * Not a product floor — nobody wants a five-second approval wait — but the one
 * that makes the unanswered path testable end to end: a spec has to wait the
 * window out, and a floor of minutes would put a real timeout beyond any e2e run.
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
 * What a conversation's owner has switched off for its runs (chat and agent
 * threads; a routine and a sub-agent are always reviewed). It can be turned
 * back on at any point, mid-run included.
 */
export interface RunLimits {
  /** No progress review for this conversation's runs: nothing then bounds a
   * run but its owner pressing Stop. */
  progressReviewOff: boolean;
}

/** Everything on: what a run has until told otherwise, and what it falls back
 * to when the conversation could not be read. */
export const LIMITS_ON: RunLimits = { progressReviewOff: false };

/** A `RunLimits` on the wire. Absent means left as it is, or on for a new
 * conversation. */
export interface RunLimitChoices {
  progress_review_off?: boolean;
}

/** An untrusted `run_limits` as what it asks for, dropping anything that is
 * not a boolean; `undefined` when nothing is left. */
export function normalizeRunLimits(value: unknown): RunLimitChoices | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { progress_review_off: off } = value as Record<string, unknown>;
  return typeof off === "boolean" ? { progress_review_off: off } : undefined;
}
