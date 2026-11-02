import type { RunLimitChoices, RunLimits } from '@loxaic/types';

/**
 * A conversation's run limits, as the `+` menu offers them: what turns off
 * which check-in, for this chat alone. The hook (`useRunLimits`) wires these to
 * the server and the rows (`RunLimitRows`) render them.
 */

/** What the session and the switches hand each other: the choices a new
 * conversation's first send carries, and the way to hear a change made
 * elsewhere. A ref, because the switches need the session's `activeId` and so
 * are created after it. */
export interface RunLimitsLink {
  pending: RunLimitChoices | undefined;
  onChange: (conversationId: string, limits: RunLimits) => void;
}

/** A conversation row's limits. An older server sends neither, and has every
 * limit on. */
export function limitsOf(row: { stepLimitOff?: boolean; loopCheckOff?: boolean }): RunLimits {
  return { stepLimitOff: row.stepLimitOff === true, loopCheckOff: row.loopCheckOff === true };
}

/** What a new conversation's first send carries: only what was turned off, and
 * nothing at all when that is nothing. */
export function limitsToSend(limits: RunLimits): RunLimitChoices | undefined {
  if (!limits.stepLimitOff && !limits.loopCheckOff) return undefined;
  return {
    ...(limits.stepLimitOff ? { step_limit_off: true } : {}),
    ...(limits.loopCheckOff ? { loop_check_off: true } : {}),
  };
}

export function sameLimits(a: RunLimits, b: RunLimits): boolean {
  return a.stepLimitOff === b.stepLimitOff && a.loopCheckOff === b.loopCheckOff;
}

export type RunLimitKey = keyof RunLimits;

export interface RunLimitRow {
  key: RunLimitKey;
  testID: string;
  label: string;
  sublabel: string;
  /** The switch: on means the limit applies, as its name says. */
  on: boolean;
}

export function runLimitRows(limits: RunLimits): RunLimitRow[] {
  return [
    {
      key: 'stepLimitOff',
      testID: 'composer.plus.stepLimit',
      label: 'Step limit',
      sublabel: limits.stepLimitOff ? 'Off for this chat: no pause, however many steps' : 'Pauses to ask after your step limit',
      on: !limits.stepLimitOff,
    },
    {
      key: 'loopCheckOff',
      testID: 'composer.plus.loopCheck',
      label: 'Loop check',
      sublabel: limits.loopCheckOff ? 'Off for this chat: repeating a step never pauses' : 'Pauses to ask when a step keeps repeating',
      on: !limits.loopCheckOff,
    },
  ];
}

/** The check-in banner's line about where the run is. With the step limit off
 * only the loop check asks, and the window it would count towards means nothing. */
export function checkinStepLine(checkin: { n: number; max: number; unlimited?: true }): string {
  const where = checkin.unlimited
    ? `Step ${String(checkin.n)}, with the step limit off for this chat`
    : `Step ${String(checkin.n)} of ${String(checkin.max)}`;
  return `${where} — you can change how often I check in, and how long I wait, from Settings.`;
}

/** The run header's step count. With the step limit off there is no limit to
 * count towards, and the `max` a run still sends means nothing. */
export function stepCount(iteration: { n: number; max: number; unlimited?: true }): string {
  return iteration.unlimited ? String(iteration.n) : `${String(iteration.n)}/${String(iteration.max)}`;
}
