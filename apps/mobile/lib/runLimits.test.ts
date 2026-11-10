import { describe, expect, it } from 'vitest';
import { LIMITS_ON, normalizeRunLimits } from '@loxaic/types';
import { changesInOrder, limitsOf, limitsToSend, runLimitRows, sameLimits, stepCount } from './runLimits';

describe('limitsOf', () => {
  it('has the review on for a server that sends nothing', () => {
    expect(limitsOf({})).toEqual(LIMITS_ON);
  });

  it('reads a conversation that has it off', () => {
    expect(limitsOf({ progressReviewOff: true })).toEqual({ progressReviewOff: true });
  });
});

describe('limitsToSend', () => {
  it('sends nothing when nothing is off', () => {
    expect(limitsToSend(LIMITS_ON)).toBeUndefined();
  });

  it('names the review when it is off', () => {
    expect(limitsToSend({ progressReviewOff: true })).toEqual({ progress_review_off: true });
  });
});

describe('sameLimits', () => {
  it('compares the switch', () => {
    expect(sameLimits(LIMITS_ON, { ...LIMITS_ON })).toBe(true);
    expect(sameLimits(LIMITS_ON, { progressReviewOff: true })).toBe(false);
  });
});

describe('runLimitRows', () => {
  it('shows the review in force as a switch that is on', () => {
    const [review] = runLimitRows(LIMITS_ON);
    expect(review).toMatchObject({ key: 'progressReviewOff', testID: 'composer.plus.progressReview', label: 'Progress review', on: true });
    expect(review.sublabel).toBe('An AI check steps in if a run gets stuck or keeps going after it has its answer');
  });

  it('says what turning it off means', () => {
    const [review] = runLimitRows({ progressReviewOff: true });
    expect(review.on).toBe(false);
    expect(review.sublabel).toBe('Off for this chat: nothing stops a run but you');
  });
});

describe('stepCount', () => {
  it('is the step alone', () => {
    expect(stepCount({ n: 7 })).toBe('step 7');
  });
});

describe('normalizeRunLimits', () => {
  it('keeps a boolean and drops the rest', () => {
    expect(normalizeRunLimits({ progress_review_off: true, step_limit_off: true })).toEqual({ progress_review_off: true });
    expect(normalizeRunLimits({ progress_review_off: false })).toEqual({ progress_review_off: false });
  });

  it('is nothing for anything else', () => {
    for (const value of [undefined, null, 'x', 1, {}, { progress_review_off: 1 }, { loop_check_off: true }]) {
      expect(normalizeRunLimits(value)).toBeUndefined();
    }
  });
});

describe('changesInOrder', () => {
  it('starts each change only once the one before has settled, a failed one included', async () => {
    const send = changesInOrder();
    const log: string[] = [];
    let finishFirst = (): void => undefined;
    const first = send(() => new Promise<void>((_, reject) => {
      log.push('first sent');
      finishFirst = () => { log.push('first failed'); reject(new Error('offline')); };
    }));
    const second = send(() => { log.push('second sent'); return Promise.resolve('stored'); });
    await Promise.resolve();
    expect(log).toEqual(['first sent']);
    finishFirst();
    await expect(first).rejects.toThrow('offline');
    await expect(second).resolves.toBe('stored');
    expect(log).toEqual(['first sent', 'first failed', 'second sent']);
  });
});
