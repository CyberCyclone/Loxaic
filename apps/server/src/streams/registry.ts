import type { RunActivity, StepsDecision } from "@loxaic/types";
import { announceRunActivity } from "./watchers.ts";

/**
 * Process-local registry of in-flight runs. This is deliberately NOT the
 * durable record of "what's active" (that's StreamLog meta, which survives
 * restart in Redis mode) — it only holds the things that can't be durable by
 * nature: the AbortController driving this process's inference request, and
 * pending approval resolvers for this process's tool loop.
 */
/**
 * Settles a pending approval. `answer` says who answered and whether they
 * asked for the tool to stop asking ("Allow always"); the engine decides
 * whether that person may grant it.
 */
export type ApprovalResolver = (approved: boolean, answer?: { userId: string; always: boolean }) => void;

export interface RunHandle {
  streamId: string;
  conversationId: string;
  userId: string;
  abort: AbortController;
  /** The model reference the run is using, so a context-stage switch can say
   * how many conversations are replying on a model right now. Absent on runs
   * that name none. */
  model?: string;
  /** call_id -> resolver. Approvals are run-scoped, not connection-scoped: a
   * different device/socket than the one that started the run can approve. */
  approvals: Map<string, ApprovalResolver>;
  /**
   * Set only while the run is parked at a step check-in, cleared the moment it
   * is answered. Run-scoped like `approvals`, for the same reason — whoever
   * can act on the conversation can answer, from any device.
   *
   * A plain field rather than a Map: a run has at most one check-in
   * outstanding, and it is addressed by `stream_id`, which is ours and unique
   * — unlike a model-supplied `call_id`, which is why approvals need a
   * collision-tolerant plural lookup and this does not.
   *
   * `byUserId` is null when nobody answered and the timeout decided.
   */
  stepsDecision?: (decision: StepsDecision, byUserId: string | null) => void;
  /** A sub-agent's run names the conversation that spawned it, so a question
   * about "other conversations" can tell a thread's own children from them. */
  parentConversationId?: string;
  /**
   * Place in the inference queue while the run is waiting for a slot, null
   * once it has one. Kept here as well as in the stream log because the log's
   * `run.queued` reaches only a socket following that run, and the thread list
   * needs the same fact about runs nobody is following (#282).
   *
   * Written only by `setRunQueuePosition` / `clearRunQueuePosition`, which are
   * what make the announcement below exact.
   */
  queuePosition?: number | null;
  /** Internal bookkeeping for the announcement below: what this run's
   * conversation was last told about — the activity and, while queued, the
   * place in line. Nothing outside this module reads or writes it. */
  announcedActivity?: string;
}

/**
 * What this run is doing, in the words a thread-list row says (#282).
 *
 * The order is `runLevelFromSnapshot`'s (apps/mobile/lib/agentRunState.ts)
 * with one exception, check-in and approval swapped (below), and for the same
 * reason: a run parked on an approval has handed its slot
 * back and may well be queuing to get it again, so it can carry a queue
 * position and a question at once — and the question is the thing a person can
 * act on. A check-in outranks an approval only because the run asks one thing
 * of them at a time and the check-in is the newer, blocking-er of the two; in
 * practice a run holds at most one.
 */
export function runActivityOf(handle: RunHandle): RunActivity {
  if (handle.stepsDecision) return "awaiting_checkin";
  if (handle.approvals.size > 0) return "awaiting_approval";
  if (handle.queuePosition !== null && handle.queuePosition !== undefined) return "queued";
  return "running";
}

/** The dedup key: the activity, plus the place in line while queued, so a run
 * moving from #3 to #2 says something and one merely re-asking the same
 * question says nothing. */
function activityKeyOf(handle: RunHandle): string {
  const activity = runActivityOf(handle);
  return activity === "queued" ? `queued:${String(handle.queuePosition ?? 0)}` : activity;
}

/**
 * Tell the watchers what this run is doing now, if that is not what they were
 * last told. Every mutation of a run's activity goes through one of the
 * functions below so this stays exact — a direct `run.approvals.set(...)`
 * would change the answer with nobody noticing.
 */
function announceActivity(handle: RunHandle): void {
  const key = activityKeyOf(handle);
  if (handle.announcedActivity === key) return;
  handle.announcedActivity = key;
  announceRunActivity(handle.conversationId);
}

/** Offer an approval for one tool call and say the run is waiting on a person. */
export function setRunApproval(handle: RunHandle, callId: string, resolver: ApprovalResolver): void {
  handle.approvals.set(callId, resolver);
  announceActivity(handle);
}

/** Withdraw it — answered, timed out, or stopped. Idempotent: a call that
 * never had one pending changes nothing, and a stray delete must not clear a
 * *later* call's prompt from the row. */
export function clearRunApproval(handle: RunHandle, callId: string): void {
  if (!handle.approvals.delete(callId)) return;
  announceActivity(handle);
}

/** Park the run at a step check-in. */
export function setRunCheckin(handle: RunHandle, resolver: (decision: StepsDecision, byUserId: string | null) => void): void {
  handle.stepsDecision = resolver;
  announceActivity(handle);
}

/** Take the outstanding check-in's resolver, or null when the run is not
 * parked. Taking it is the answer landing (from any device, or the timeout),
 * so the row stops saying "Waiting for you". */
export function takeRunCheckin(handle: RunHandle): ((decision: StepsDecision, byUserId: string | null) => void) | null {
  const resolver = handle.stepsDecision ?? null;
  if (!resolver) return null;
  handle.stepsDecision = undefined;
  announceActivity(handle);
  return resolver;
}

/** Clear the check-in slot when the wait settles by any other route (the
 * engine's own timeout or abort). A no-op — and so a non-announcement — when
 * nobody had parked the run, which is the case once `takeRunCheckin` has
 * already run. */
export function clearRunCheckin(handle: RunHandle): void {
  if (!handle.stepsDecision) return;
  handle.stepsDecision = undefined;
  announceActivity(handle);
}

/** Record where a waiting run is in line. */
export function setRunQueuePosition(handle: RunHandle, position: number): void {
  handle.queuePosition = position;
  announceActivity(handle);
}

/** The run has its slot. A no-op on a run that never waited, which is the
 * common case — an immediately-admitted run must not announce twice. */
export function clearRunQueuePosition(handle: RunHandle): void {
  if (handle.queuePosition === null || handle.queuePosition === undefined) return;
  handle.queuePosition = null;
  announceActivity(handle);
}

const runsByStreamId = new Map<string, RunHandle>();
/** conversationId -> streamId — enforces one active run per conversation. */
const runByConversation = new Map<string, string>();

export function registerRun(handle: RunHandle): void {
  runsByStreamId.set(handle.streamId, handle);
  runByConversation.set(handle.conversationId, handle.streamId);
  announceActivity(handle);
}

/** Refused because the conversation already has a run (or a rewind) going. */
export class ConversationBusyError extends Error {
  readonly code = "conversation_busy";
  constructor(message = "A response is already in progress for this conversation") {
    super(message);
    this.name = "ConversationBusyError";
  }
}

/**
 * Takes the conversation's one run slot, or throws when something holds it.
 *
 * Synchronous on purpose: the check and the claim have to be one step. With
 * an await between them, two requests arriving together each pass the check
 * and `registerRun` silently overwrites the first — a send and a rewind could
 * then both proceed, the send writing into the very suffix the rewind is
 * removing. Every starter claims this way before its first await that matters.
 */
export function claimConversation(handle: RunHandle): void {
  if (runByConversation.has(handle.conversationId)) throw new ConversationBusyError();
  registerRun(handle);
}

export function unregisterRun(streamId: string): void {
  const handle = runsByStreamId.get(streamId);
  if (!handle) return;
  runsByStreamId.delete(streamId);
  if (runByConversation.get(handle.conversationId) === streamId) {
    runByConversation.delete(handle.conversationId);
    const waiters = runEndWaiters.get(handle.conversationId);
    if (waiters) {
      runEndWaiters.delete(handle.conversationId);
      for (const resolve of waiters) resolve(true);
    }
    // The conversation is idle now — say so. Inside this branch, so only the
    // run holding the conversation announces: a stale unregister of a
    // superseded stream must not announce the *new* run's conversation idle.
    announceRunActivity(handle.conversationId);
  }
}

/** conversationId -> resolvers waiting for its run to finish. */
const runEndWaiters = new Map<string, ((ended: boolean) => void)[]>();

/**
 * Resolves once no run holds `conversationId` — true if it ended, false if
 * `timeoutMs` elapsed first.
 *
 * Deleting a conversation aborts its run and then has to wait for the loop to
 * actually unwind before it can claim the work is gone: an aborting run is
 * still writing (a stopped tool result, a cancelled assistant row), and those
 * rows land *after* the delete transaction commits. Polling would do, but an
 * abort is an event the registry already observes, and the wait is on the
 * cleanup path of a user action — a 250 ms poll would add a quarter-second to
 * every delete for nothing.
 *
 * Bounded, because the waiter is not the only thing that can go wrong: a run
 * wedged inside a tool call never reaches `unregisterRun`, and the caller
 * still has cleanup to do. Resolving false is a fact the caller logs, not an
 * error — the second purge pass is what makes the wait an optimisation rather
 * than a correctness requirement.
 */
export function waitForRunEnd(conversationId: string, timeoutMs: number): Promise<boolean> {
  if (!runByConversation.has(conversationId)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ended: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ended);
    };
    const timer = setTimeout(() => {
      const waiters = runEndWaiters.get(conversationId);
      if (waiters) {
        const next = waiters.filter((w) => w !== done);
        if (next.length === 0) runEndWaiters.delete(conversationId);
        else runEndWaiters.set(conversationId, next);
      }
      done(false);
    }, timeoutMs);
    // Never hold the process open for a wait whose whole purpose is cleanup.
    timer.unref();
    const existing = runEndWaiters.get(conversationId);
    if (existing) existing.push(done);
    else runEndWaiters.set(conversationId, [done]);
  });
}

/** Runs in flight on `model`, other than `exceptConversationId`'s own and
 * its sub-agents' — a thread's children are part of it, not other people. */
export function runsUsingModel(model: string, exceptConversationId?: string): RunHandle[] {
  return [...runsByStreamId.values()].filter(
    (r) =>
      r.model === model &&
      r.conversationId !== exceptConversationId &&
      (exceptConversationId === undefined || r.parentConversationId !== exceptConversationId),
  );
}

export function getRun(streamId: string): RunHandle | undefined {
  return runsByStreamId.get(streamId);
}

export function getRunByConversation(conversationId: string): RunHandle | undefined {
  const streamId = runByConversation.get(conversationId);
  return streamId ? runsByStreamId.get(streamId) : undefined;
}

/**
 * The runs in flight among `conversationIds` (#282), for the thread list's
 * watch to answer with. A plain scan: the registry holds one entry per live
 * run on this process — tens, not thousands — and building a second index
 * over it would be another thing to keep in step with the first.
 */
export function listBusyRuns(conversationIds: Iterable<string>): RunHandle[] {
  const wanted = new Set(conversationIds);
  const out: RunHandle[] = [];
  for (const handle of runsByStreamId.values()) {
    if (wanted.has(handle.conversationId)) out.push(handle);
  }
  return out;
}

export function isConversationBusy(conversationId: string): boolean {
  return runByConversation.has(conversationId);
}

/**
 * Every run with a pending approval for `callId`.
 *
 * Approve/deny carry only a call_id, so this locates; it does **not**
 * authorize — callers check the caller's role on each `conversationId` (see
 * ws/chat.ts's `mayActOnRun`) and act on the one that passes.
 *
 * Plural, deliberately. `call_id` is *model*-supplied and only unique within
 * one response: chat templates routinely emit `call_0`, `call_1`, and the
 * local fallback is `call_<index>_<ms>`, which two runs starting in the same
 * millisecond share. Returning the first match let an approval land on a
 * different run that happened to hold the same id — and, across two users,
 * silently swallow the legitimate one. Handing back all candidates lets the
 * caller pick the run they are actually allowed to answer for.
 */
/**
 * Whether a check-in answer off a socket is one we recognise.
 *
 * Takes `unknown` on purpose, the same way `isValidRef` does. The wire type
 * already *says* `StepsDecision`, so a check written against that type is
 * narrowed to a tautology and compiled away — but the type is a claim a client
 * made, not a fact, and this is the only place it becomes one.
 */
export function isStepsDecision(value: unknown): value is StepsDecision {
  return value === "continue" || value === "answer";
}

export function findRunsByApprovalCallId(callId: string): RunHandle[] {
  const out: RunHandle[] = [];
  for (const handle of runsByStreamId.values()) {
    if (handle.approvals.has(callId)) out.push(handle);
  }
  return out;
}
