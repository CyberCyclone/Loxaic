/**
 * How long a run parked at a tool approval waits for a person.
 *
 * Pure, so every rule here is asserted directly (timeouts.test.ts) rather than
 * by waiting out real timers. The engine owns the timers; this owns the
 * numbers and the decisions.
 */
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, type TimeoutBasis } from "@loxaic/types";

/**
 * A stored window, made safe to use.
 *
 * Clamped on read as well as validated on write: the column is plain data,
 * and a value that arrived
 * some other way (a hand-edited row, a future admin tool) must not be able to
 * expire every wait instantly or park a run for weeks. Null stays null — it
 * means "use the server default", which is a choice, not a missing value.
 */
export function clampWaitTimeoutMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, Math.round(value)));
}

/**
 * The window a wait uses when the user has not chosen one: the operator's
 * `APPROVAL_TIMEOUT_MS`, else the built-in ten minutes.
 *
 * Read at call time, never at module load: vitest shares one process across
 * files, and a value captured at import could not be overridden by a test that
 * needs a window it can actually wait out.
 *
 * Deliberately *below* a user's own choice in precedence, unlike the sandbox
 * settings where an env pin outranks the database. Those are deployment-wide
 * security decisions an admin owns; this is how long one person is willing to
 * be waited on, over an operator default. A parked run has handed its
 * inference slot back, so a long wait costs the deployment nothing that a pin
 * would protect — and a pin would leave the setting on screen and inert.
 *
 * No lower bound: tests set this to 50 ms. Clamped above to
 * `MAX_WAIT_TIMEOUT_MS`, which keeps it far below the 2**31 - 1 point where
 * Node silently turns a delay into 1 ms.
 */
export function serverDefaultTimeoutMs(): number {
  const raw = Number(process.env.APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
}

/**
 * The window a particular wait actually gets.
 *
 * `baseMs` is the user's setting or the server default. With `adaptive` on,
 * the window is never shorter than twice this run's slowest model request so
 * far: on a backend where one step takes twenty minutes, expecting a person to
 * answer in ten is asking them to watch continuously through steps they cannot
 * speed up. Twice, so someone who looks in once a step still catches it.
 *
 * `slowestTurnMs` times the model request only — send to done — never a whole
 * iteration. An iteration includes approval waits, and counting those would
 * let one long-unanswered approval lengthen every later window.
 */
export function effectiveTimeoutMs(input: {
  baseMs: number;
  adaptive: boolean;
  slowestTurnMs: number;
}): { ms: number; basis: TimeoutBasis } {
  const floor = input.adaptive ? 2 * Math.max(0, input.slowestTurnMs) : 0;
  const stretched = floor > input.baseMs;
  return {
    ms: Math.min(MAX_WAIT_TIMEOUT_MS, stretched ? floor : input.baseMs),
    basis: stretched ? "adaptive" : "setting",
  };
}
