import { describe, expect, it } from 'vitest';
import { LIMITS_ON, normalizeRunLimits } from '@loxaic/types';
import { limitsOf, limitsToSend, runLimitRows, sameLimits, stepCount } from './runLimits';

describe('limitsOf', () => {
  it('has every limit on for a server that sends neither', () => {
    expect(limitsOf({})).toEqual(LIMITS_ON);
  });

  it('reads what a conversation has off', () => {
    expect(limitsOf({ stepLimitOff: true, loopCheckOff: false })).toEqual({ stepLimitOff: true, loopCheckOff: false });
  });
});

describe('limitsToSend', () => {
  it('sends nothing when nothing is off', () => {
    expect(limitsToSend(LIMITS_ON)).toBeUndefined();
  });

  it('names only what is off', () => {
    expect(limitsToSend({ stepLimitOff: true, loopCheckOff: false })).toEqual({ step_limit_off: true });
    expect(limitsToSend({ stepLimitOff: false, loopCheckOff: true })).toEqual({ loop_check_off: true });
  });
});

describe('sameLimits', () => {
  it('compares both', () => {
    expect(sameLimits(LIMITS_ON, { ...LIMITS_ON })).toBe(true);
    expect(sameLimits(LIMITS_ON, { ...LIMITS_ON, loopCheckOff: true })).toBe(false);
  });
});

describe('runLimitRows', () => {
  it('shows a limit in force as a switch that is on', () => {
    const [step, loop] = runLimitRows(LIMITS_ON);
    expect(step).toMatchObject({ key: 'stepLimitOff', testID: 'composer.plus.stepLimit', on: true });
    expect(loop).toMatchObject({ key: 'loopCheckOff', testID: 'composer.plus.loopCheck', on: true });
  });

  it('says what turning one off means, on that row alone', () => {
    const [step, loop] = runLimitRows({ stepLimitOff: true, loopCheckOff: false });
    expect(step.on).toBe(false);
    expect(step.sublabel).toContain('Off for this chat');
    expect(loop.on).toBe(true);
    expect(loop.sublabel).not.toContain('Off for this chat');
  });
});

describe('stepCount', () => {
  it('counts towards the limit', () => {
    expect(stepCount({ n: 7, max: 50 })).toBe('7/50');
  });

  it('drops a limit that is off', () => {
    expect(stepCount({ n: 7, max: 57, unlimited: true })).toBe('7');
  });
});

describe('normalizeRunLimits', () => {
  it('keeps booleans and drops the rest', () => {
    expect(normalizeRunLimits({ step_limit_off: true, loop_check_off: 'x' })).toEqual({ step_limit_off: true });
    expect(normalizeRunLimits({ loop_check_off: false })).toEqual({ loop_check_off: false });
  });

  it('is nothing for anything else', () => {
    for (const value of [undefined, null, 'x', 1, {}, { step_limit_off: 1 }]) expect(normalizeRunLimits(value)).toBeUndefined();
  });
});
