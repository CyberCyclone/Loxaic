import type { RunActivity } from '@loxaic/types';
import type { RunState } from './agentRunState';

/**
 * The words and the dot colour for each run state, in one place.
 *
 * They used to live in the agent header alone. The thread list now says the
 * same thing about every row that has a run going (#282), and a row that
 * called `awaiting_checkin` "Waiting" while the header said "Waiting for you"
 * is the kind of drift nobody notices until a support thread quotes both.
 * `RunHeader` renders from here, so the row cannot disagree with the header
 * without someone editing this file and meaning to.
 */
export const STATE_LABEL: Record<RunState, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  // Not "Awaiting answer": the run is asking a question, and the person it is
  // asking is the one reading this.
  awaiting_checkin: 'Waiting for you',
  stopping: 'Stopping…',
  done: 'Done',
  error: 'Error',
};

export const STATE_DOT: Record<RunState, string> = {
  // Amber, like awaiting_approval: both mean "this run exists but is not
  // doing anything", which is the distinction a status dot is for.
  queued: 'bg-warning',
  running: 'bg-primary',
  awaiting_approval: 'bg-warning',
  awaiting_checkin: 'bg-warning',
  // Amber too: asked to stop, but not stopped — the run is still winding up.
  stopping: 'bg-warning',
  done: 'bg-success',
  error: 'bg-destructive',
};

/** What a thread-list row may be told about a run: the server's vocabulary
 * (`RunActivity`) plus `stopping`, which has no server counterpart and is
 * overlaid locally on the conversation whose Stop was pressed (#113). */
export type RowRunState = RunActivity | 'stopping';

/**
 * A row's run label: the state's word, with the place in line when queued —
 * the header's `Queued · #2`, in the row's own shorter shape.
 */
export function rowRunLabel(state: RowRunState, queuePosition?: number): string {
  if (state === 'queued' && queuePosition) return `Queued · #${String(queuePosition)}`;
  return STATE_LABEL[state];
}
