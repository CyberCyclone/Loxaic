import { describe, expect, it } from 'vitest';
import { answerNowNotice, autoContinueNotice } from './checkinNotice';

describe('answerNowNotice', () => {
  it('credits the person who pressed it', () => {
    expect(answerNowNotice('me', 'me')).toBe('You asked for an answer with what it had so far.');
    expect(answerNowNotice('them', 'me')).toBe('Someone else in this conversation asked for an answer with what it had so far.');
  });

  it('says nobody did when the check-in timed out', () => {
    expect(answerNowNotice(null, 'me')).toBe('Nobody answered the check-in, so it wrapped up with what it had so far.');
  });

  it('claims neither when we were not told', () => {
    expect(answerNowNotice(undefined, 'me')).toBe('It was asked to answer with what it had so far.');
  });

  it('never says "you" without knowing who you are', () => {
    expect(answerNowNotice('me', undefined)).not.toMatch(/^You/);
  });
});

describe('autoContinueNotice', () => {
  it('names the step and where it is on the ladder', () => {
    expect(autoContinueNotice({ decision: 'continue', by: 'timeout', n: 20, unattended: 1, auto_continues: 2 })).toBe(
      'Nobody answered the check-in at step 20, so it kept going (1 of 2 before it wraps up).',
    );
  });

  it('degrades when the counts are missing', () => {
    expect(autoContinueNotice({ decision: 'continue', by: 'timeout' })).toBe('Nobody answered the check-in, so it kept going.');
  });

  it('says nothing about a person\'s decision or a timed-out answer', () => {
    expect(autoContinueNotice({ decision: 'continue', by: 'user', n: 3 })).toBeNull();
    expect(autoContinueNotice({ decision: 'answer', by: 'timeout', n: 3 })).toBeNull();
    expect(autoContinueNotice(undefined)).toBeNull();
  });
});
