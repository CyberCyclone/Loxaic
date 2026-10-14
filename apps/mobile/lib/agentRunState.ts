import type { StreamEventKind, StreamSnapshot } from '@loxaic/api-client';
import { toPendingApproval, toPendingCheckin, type PendingApproval, type PendingCheckin } from './pendingWaits';

/**
 * `queued` means the run exists and is waiting for an inference slot —
 * distinct from `running`, because nothing is happening yet and the user is
 * owed the reason.
 *
 * `stopping` is client-side only: the server has no such status, and the run
 * really is still running until its stream ends. It exists because pressing
 * Stop used to change nothing on screen — the run kept saying "Running" until
 * it actually wound up, which for a run mid-tool-call is not instant — so the
 * button read as broken (#113). This is the acknowledgement, not a claim that
 * anything has stopped yet.
 *
 * `awaiting_checkin` is the run asking whether to keep going — the same kind
 * of pause as `awaiting_approval` (slot handed back, waiting on a person),
 * which is why it sits beside it rather than being folded into `running`.
 */
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_checkin'
  | 'stopping'
  | 'done'
  | 'error';

/**
 * Where one agent conversation's run is: what it is doing, what it is asking,
 * how far it has got. Kept per conversation, never as one value for "the
 * thread on screen".
 *
 * It used to be flat hook state, cleared on every thread switch and written
 * only by events for the thread on screen. A run that asked for an MCP tool's
 * approval while its thread was open, then had its thread switched away from
 * and back to, came back with no prompt and a "Done" pill — while the run sat
 * parked on the server waiting for an answer nobody could give. Nothing
 * brought it back: the socket had already subscribed to that conversation, so
 * reopening it asked for no snapshot. Seen on the beta.
 */
export interface AgentRunLevel {
  runState: RunState;
  pendingApproval: PendingApproval | null;
  pendingCheckin: PendingCheckin | null;
  iteration: { n: number; max: number } | null;
  queuePosition: number | null;
}

export const IDLE_RUN: AgentRunLevel = Object.freeze({
  runState: 'done',
  pendingApproval: null,
  pendingCheckin: null,
  iteration: null,
  queuePosition: null,
});

export type RunLevels = Partial<Record<string, AgentRunLevel>>;

/** A conversation's run, or the idle state when nothing has been heard. */
export function runLevelOf(levels: RunLevels, convId: string | null | undefined): AgentRunLevel {
  return (convId ? levels[convId] : undefined) ?? IDLE_RUN;
}

/** `levels` with one conversation's run replaced; the same object when nothing changed. */
export function withRunLevel(
  levels: RunLevels,
  convId: string,
  update: (prev: AgentRunLevel) => AgentRunLevel,
): RunLevels {
  const prev = runLevelOf(levels, convId);
  const next = update(prev);
  return next === prev ? levels : { ...levels, [convId]: next };
}

/** `levels` without one conversation (deleted, say). */
export function withoutRunLevel(levels: RunLevels, convId: string): RunLevels {
  if (!(convId in levels)) return levels;
  return Object.fromEntries(Object.entries(levels).filter(([key]) => key !== convId));
}

/**
 * A run's state as a snapshot describes it. `serverNow` is passed through as
 * it arrived, never defaulted to `now`: absent, `localDeadline` re-bases the
 * wait as if it had just started, which only errs long. Substituting `now`
 * would instead read the server's `expires_at` straight off this device's
 * clock, skew and all.
 */
export function runLevelFromSnapshot(
  snapshot: StreamSnapshot,
  status: 'active' | 'complete' | 'error' | 'cancelled',
  streamId: string,
  now: number,
  serverNow?: number,
): AgentRunLevel {
  let runState: RunState;
  if (status === 'active') {
    // Order matters: a snapshot can carry both a queue position and a pending
    // approval (a run that yielded its slot to ask, then had to queue to get
    // it back). The approval is what the user can act on, so it wins — and a
    // check-in is the same kind of thing, so it outranks the queue too.
    if (snapshot.pending_approval) runState = 'awaiting_approval';
    else if (snapshot.pending_checkin) runState = 'awaiting_checkin';
    else if (snapshot.queued) runState = 'queued';
    else runState = 'running';
  } else runState = status === 'error' ? 'error' : 'done';
  return {
    runState,
    iteration: snapshot.iteration ?? null,
    // Only an active run can be waiting on anyone. The server strips a
    // finished run's question from its snapshot (delivery.ts), but the bar and
    // the banner render on a prompt's presence alone, and every conversation's
    // snapshot is kept now — not only the one on screen — so a finished run
    // must not bring two buttons that can do nothing back on a switch.
    pendingApproval: status === 'active' && snapshot.pending_approval
      ? toPendingApproval(snapshot.pending_approval, now, serverNow, streamId) : null,
    pendingCheckin: status === 'active' && snapshot.pending_checkin
      ? toPendingCheckin(snapshot.pending_checkin, now, serverNow, streamId) : null,
    queuePosition: snapshot.queued?.position ?? null,
  };
}

/** One live event on a conversation's run. Returns `prev` when it changes nothing. */
export function runLevelAfterEvent(
  prev: AgentRunLevel,
  event: StreamEventKind,
  streamId: string,
  now: number,
): AgentRunLevel {
  let next = prev;
  // Anything that is not itself a queue update means the run is past the
  // queue: a compaction run never emits `iteration`, and an agent run
  // re-queued after an approval emits its tool results before its next one —
  // both left "Queued · #N" on screen with the response streaming underneath.
  if (event.kind !== 'run.queued' && (next.queuePosition !== null || next.runState === 'queued')) {
    next = { ...next, queuePosition: null, runState: next.runState === 'queued' ? 'running' : next.runState };
  }
  switch (event.kind) {
    case 'run.queued':
      return { ...next, runState: 'queued', queuePosition: event.position };
    case 'iteration':
      return { ...next, runState: 'running', iteration: { n: event.n, max: event.max } };
    case 'approval.request':
      return { ...next, runState: 'awaiting_approval', pendingApproval: toPendingApproval(event, now, undefined, streamId) };
    case 'tool.result':
      return {
        ...next,
        runState: 'running',
        pendingApproval: next.pendingApproval?.callId === event.call_id ? null : next.pendingApproval,
      };
    case 'steps.checkin':
      // The header shows the step count, and this is the moment it matters
      // most — so it is kept in step with the question.
      return {
        ...next,
        runState: 'awaiting_checkin',
        pendingCheckin: toPendingCheckin(event, now, undefined, streamId),
        iteration: { n: event.n, max: event.max },
      };
    case 'steps.decision':
      // Someone answered — possibly on another device, possibly the timeout.
      return { ...next, runState: 'running', pendingCheckin: null };
    default:
      return next;
  }
}

/** The run's stream ended. */
export function runLevelAfterEnd(prev: AgentRunLevel, status: string): AgentRunLevel {
  return {
    ...prev,
    runState: status === 'error' ? 'error' : 'done',
    iteration: null,
    queuePosition: null,
    pendingApproval: null,
    pendingCheckin: null,
  };
}

/**
 * A rewind or retry removed runs. A prompt from a removed run goes; the live
 * counters go only when the run being followed is a removed one
 * (`clearsLiveRun`, from `rewindClearsLiveRun`) — a retry's new run can
 * already be the one on screen.
 *
 * The state goes with the prompt. A run left `awaiting_approval` with no
 * approval kept Stop and refused a send, and Stop then found no stream (the
 * rewind cleared it) and said to reload. Switching threads used to reset
 * `runState`, which hid this; with state kept per conversation nothing did.
 * When the followed run was removed, nothing of it is running any more:
 * `done`. When a retry's run is the one followed, an approval from a removed
 * run was never that run's question, so it is `running`.
 */
export function runLevelAfterRewind(
  prev: AgentRunLevel,
  removedStreams: ReadonlySet<string>,
  clearsLiveRun: boolean,
): AgentRunLevel {
  // A prompt that names its run goes when that run went. One that does not
  // (a check-in from before `streamId`) can only be the followed run's.
  const removed = (streamId: string | undefined) =>
    streamId ? removedStreams.has(streamId) : clearsLiveRun;
  const pendingApproval = prev.pendingApproval && removed(prev.pendingApproval.streamId) ? null : prev.pendingApproval;
  const pendingCheckin = prev.pendingCheckin && removed(prev.pendingCheckin.streamId) ? null : prev.pendingCheckin;
  const dropped = pendingApproval !== prev.pendingApproval || pendingCheckin !== prev.pendingCheckin;
  if (!dropped && !clearsLiveRun) return prev;
  let runState = prev.runState;
  if (pendingApproval) runState = 'awaiting_approval';
  else if (pendingCheckin) runState = 'awaiting_checkin';
  else if (clearsLiveRun) runState = prev.runState === 'error' ? 'error' : 'done';
  else if (prev.runState === 'awaiting_approval' || prev.runState === 'awaiting_checkin') runState = 'running';
  return {
    ...prev,
    runState,
    pendingApproval,
    pendingCheckin,
    ...(clearsLiveRun ? { iteration: null, queuePosition: null } : {}),
  };
}

/**
 * A new conversation's placeholder id became its real one (`turn.started`).
 * Whatever was recorded under the placeholder moves, unless the real id has
 * already been heard from — its own events are newer.
 */
export function withPromotedRunLevel(levels: RunLevels, localId: string, realId: string): RunLevels {
  const local = levels[localId];
  if (!local || localId === realId) return levels;
  const rest = withoutRunLevel(levels, localId);
  return realId in levels ? rest : { ...rest, [realId]: local };
}
