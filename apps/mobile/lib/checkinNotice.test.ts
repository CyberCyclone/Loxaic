import { describe, expect, it } from 'vitest';
import { answerNowNotice } from './checkinNotice';

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
