/**
 * When the server compacts a conversation without being asked.
 *
 * Deliberately its own module, importing nothing from either side. The engine
 * needs the policy and `compactRun` needs the engine's history loader, so
 * putting the policy in `compactRun.ts` would make those two modules import
 * each other. That cycle happens to work today only because every binding
 * crossing it is a hoisted function declaration — the first module-level
 * `const` computed from the other side would break it, at load time, depending
 * on which module Node reached first. Not a trap worth leaving lying around.
 *
 * (The engine still needs `startCompactRun` itself, which genuinely does live
 * on the other side of that cycle; it reaches it through a dynamic import at
 * the one point it fires.)
 */

/**
 * Fraction of the model's context window at which the server compacts on its
 * own. Env-overridable; `0` — or anything outside 0-1 — disables it entirely.
 *
 * The default leaves real headroom on purpose. The check runs *after* a turn
 * finishes, so the threshold has to be low enough that the turn following it
 * still fits, and a local model's window is small enough that one large tool
 * result can move things a long way in a single step.
 */
export const AUTO_COMPACT_THRESHOLD = (() => {
  const raw = Number(process.env.AUTO_COMPACT_THRESHOLD ?? "0.85");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0;
})();

/**
 * Replayed messages required before the server will compact on its own.
 *
 * Two jobs. It stops a thread being compacted while it is still short enough
 * to simply read — and, more importantly, it stops thrashing. After a
 * compaction the replay restarts at zero, so without a floor a conversation
 * whose *summary alone* sits near the threshold would re-compact on every
 * single turn, spending a model call and a full prompt re-evaluation each time
 * to save nothing.
 *
 * Manual `/compact` is deliberately not subject to this: asking for it is a
 * decision, and its own no-op guard already refuses the degenerate cases.
 */
export const AUTO_COMPACT_MIN_MESSAGES = 8;

export interface AutoCompactInput {
  /** prompt + completion of the turn that just finished. */
  usedTokens: number;
  /**
   * The window the prompt was actually assembled against, or null when the
   * backend never told us. A fraction of an unknown is not a number, so
   * nothing fires — silently doing nothing is the right failure here, because
   * the alternative is compacting a conversation on a guess.
   */
  windowTokens: number | null;
  /** Messages the next prompt would replay, i.e. since any existing summary. */
  historyMessages: number;
}

/**
 * Whether a finished turn should be followed by an automatic compaction.
 *
 * Pure and exported for tests: a threshold that silently never fires is
 * indistinguishable from one that works, right up until a conversation gets
 * long — which is exactly when nobody is watching it.
 */
export function shouldAutoCompact(input: AutoCompactInput): boolean {
  if (AUTO_COMPACT_THRESHOLD <= 0) return false;
  const { windowTokens } = input;
  if (windowTokens == null || windowTokens <= 0) return false;
  if (input.historyMessages < AUTO_COMPACT_MIN_MESSAGES) return false;
  return input.usedTokens >= windowTokens * AUTO_COMPACT_THRESHOLD;
}
