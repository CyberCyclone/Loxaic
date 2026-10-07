/**
 * What happens when a conversation fills the model's context: nothing yet, a
 * larger context stage, a compaction, or — when neither can help — an honest
 * stop. One pure function, used before every request of a run and after every
 * turn, so the two can never disagree.
 *
 * Deliberately its own module, importing neither the engine nor compactRun. The
 * engine needs the policy and `compactRun` needs the engine's history loader,
 * so putting the policy in `compactRun.ts` would make those two modules import
 * each other. That cycle happens to work today only because every binding
 * crossing it is a hoisted function declaration — the first module-level
 * `const` computed from the other side would break it, at load time, depending
 * on which module Node reached first. Not a trap worth leaving lying around.
 *
 * (The engine still needs the compaction itself, which genuinely does live on
 * the other side of that cycle; it reaches it through a dynamic import.)
 *
 * There is no switch to turn this off. A conversation that fills its window is
 * compacted or extended, never trimmed: the history window that used to drop
 * the oldest rows lost people's own requests silently (see `loadHistory`), and
 * a request over the window is one llama.cpp cuts off mid-reply.
 */

/**
 * Fraction of the model's context window at which a conversation counts as
 * full. Env-overridable (tests drop it to something a mock can reach); `0` —
 * or anything outside 0-1 — disables it entirely.
 *
 * The default leaves real headroom on purpose: the after-turn check runs once
 * the turn is over, so the turn that follows still has to fit, and a local
 * model's window is small enough that one large tool result moves things a
 * long way in a single step.
 */
export const AUTO_COMPACT_THRESHOLD = (() => {
  const raw = Number(process.env.AUTO_COMPACT_THRESHOLD ?? "0.85");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0;
})();

/**
 * Replayed messages required before a compaction runs on its own.
 *
 * Two jobs. It stops a thread being compacted while it is still short enough
 * to simply read — and, more importantly, it stops thrashing. After a
 * compaction the replay restarts at zero, so without a floor a conversation
 * whose *summary alone* sits near the threshold would re-compact on every
 * request, spending a model call and a full prompt re-evaluation each time to
 * save nothing. A backend that still reports the prompt as full straight after
 * a summary is the same case.
 *
 * Manual `/compact` is deliberately not subject to this: asking for it is a
 * decision, and its own no-op guard already refuses the degenerate cases.
 * Extending is not subject to it either: one big paste can fill a short thread,
 * and a larger context helps where a summary of three messages cannot.
 */
export const AUTO_COMPACT_MIN_MESSAGES = 8;

/** Room kept free for the reply when deciding whether a request still fits. */
export function replyReserveTokens(windowTokens: number): number {
  return Math.min(1024, Math.floor(windowTokens * 0.05));
}

/** Said when a request will not fit and nothing more can make room. */
export const CANNOT_FIT_REASON =
  "This doesn't fit the model's context, and compacting the conversation can't make it fit. " +
  "Shorten the message, extend the context, or start a new conversation.";

export interface FillInput {
  /**
   * How big the prompt is: before a request of a run, the estimate of the
   * request about to go out; after a turn, its last request's measured prompt
   * plus completion. Null when nothing could be estimated.
   */
  estimatedTokens: number | null;
  /**
   * The window the prompt is assembled against, or null when the backend
   * never said. A fraction of an unknown is not a number, so nothing is done:
   * compacting on a guess rewrites a conversation for no established reason,
   * and a request that really is too large comes back as the backend's own
   * error, which the run reports.
   */
  windowTokens: number | null;
  /** Messages the next prompt replays after the newest summary, the run's own included. */
  messagesSinceSummary: number;
  /** The model's context stages, when it has any. */
  stages: { whenFull: "extend" | "compact"; active: number; count: number } | null;
  /** Before a request inside a run, or after a turn has ended. */
  phase: "mid_run" | "after_turn";
  /** Whether this run has already compacted. Before a request, a run that
   * has compacted and still does not fit is not compacted again. */
  compactedThisRun?: boolean;
}

export type FillDecision =
  | { action: "none" }
  | { action: "extend"; target: number }
  | { action: "compact" }
  | { action: "cannot"; reason: string };

/**
 * What to do about how full the conversation is.
 *
 * In order: below the threshold, nothing. A model set to extend its context
 * when full moves up a stage, stage by stage, until there is none left — then
 * compacts, as every other model does, once there is enough to be worth it
 * (the floor). Short of the floor, after a turn nothing is done (the next
 * request decides). Before a request, one that still fits is sent; one that
 * does not is compacted anyway — the floor is there to stop a summary being
 * redone for nothing, never to send a request that cannot fit — as long as
 * there is something besides the newest message to summarise and the run has
 * not already compacted; otherwise it is refused with a reason, rather than
 * sent to be cut off.
 *
 * Pure and exported for tests: a threshold that silently never fires is
 * indistinguishable from one that works, right up until a conversation gets
 * long — which is exactly when nobody is watching it.
 */
export function fillDecision(input: FillInput): FillDecision {
  if (AUTO_COMPACT_THRESHOLD <= 0) return { action: "none" };
  const { windowTokens, estimatedTokens } = input;
  if (windowTokens == null || windowTokens <= 0 || estimatedTokens == null) return { action: "none" };
  if (estimatedTokens < windowTokens * AUTO_COMPACT_THRESHOLD) return { action: "none" };
  const stages = input.stages;
  if (stages?.whenFull === "extend" && stages.active < stages.count) {
    return { action: "extend", target: stages.active + 1 };
  }
  if (input.messagesSinceSummary >= AUTO_COMPACT_MIN_MESSAGES) return { action: "compact" };
  if (input.phase === "after_turn") return { action: "none" };
  if (estimatedTokens + replyReserveTokens(windowTokens) <= windowTokens) return { action: "none" };
  return input.messagesSinceSummary >= 2 && !input.compactedThisRun
    ? { action: "compact" }
    : { action: "cannot", reason: CANNOT_FIT_REASON };
}
