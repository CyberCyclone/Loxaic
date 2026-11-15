import type { RunLimitChoices, RunLimits } from '@loxaic/types';

/**
 * A conversation's run limits, as the `+` menu offers them: the progress
 * review, switched off for this chat alone. The hook (`useRunLimits`) wires
 * these to the server and the rows (`RunLimitRows`) render them.
 */

/** What the session and the switches hand each other: the choices a new
 * conversation's first send carries, and the way to hear a change made
 * elsewhere. A ref, because the switches need the session's `activeId` and so
 * are created after it. */
export interface RunLimitsLink {
  pending: RunLimitChoices | undefined;
  onChange: (conversationId: string, limits: RunLimits) => void;
}

/** A conversation row's limits. An older server sends nothing, and has no
 * progress review to switch off. */
export function limitsOf(row: { progressReviewOff?: boolean }): RunLimits {
  return { progressReviewOff: row.progressReviewOff === true };
}

/** What a new conversation's first send carries: only what was turned off, and
 * nothing at all when that is nothing. */
export function limitsToSend(limits: RunLimits): RunLimitChoices | undefined {
  return limits.progressReviewOff ? { progress_review_off: true } : undefined;
}

export function sameLimits(a: RunLimits, b: RunLimits): boolean {
  return a.progressReviewOff === b.progressReviewOff;
}

export type RunLimitKey = keyof RunLimits;

export interface RunLimitRow {
  key: RunLimitKey;
  testID: string;
  label: string;
  sublabel: string;
  /** The switch: on means the check applies, as its name says. */
  on: boolean;
}

export function runLimitRows(limits: RunLimits): RunLimitRow[] {
  return [
    {
      key: 'progressReviewOff',
      testID: 'composer.plus.progressReview',
      label: 'Progress review',
      sublabel: limits.progressReviewOff
        ? 'Off for this chat: nothing stops a run but you'
        : 'An AI check steps in if a run gets stuck or keeps going after it has its answer',
      on: !limits.progressReviewOff,
    },
  ];
}

/** The run header's step count ("Running · step 7"): just the step, since
 * nothing counts it towards a limit any more. */
export function stepCount(iteration: { n: number }): string {
  return `step ${String(iteration.n)}`;
}

/**
 * A queue that starts each change once the one before has settled, failed
 * ones included. Two quick toggles otherwise race to the server, which can
 * store the first after the second; in order, what is stored is the last.
 */
export function changesInOrder(): <T>(send: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (send) => {
    const sent = tail.then(send);
    tail = sent.catch(() => undefined);
    return sent;
  };
}
