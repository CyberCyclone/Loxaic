import { describe, expect, it } from 'vitest';
import { deadlineSentence, formatCountdown, formatDuration } from './waitSettings';

describe('formatDuration', () => {
  it('reads at a glance', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(10 * 60_000)).toBe('10 min');
    expect(formatDuration(60 * 60_000)).toBe('1 h');
    expect(formatDuration(90 * 60_000)).toBe('1 h 30 min');
  });
});

describe('formatCountdown', () => {
  it('counts down in m:ss, and h:mm:ss past the hour', () => {
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('deadlineSentence', () => {
  it('says an approval will not run', () => {
    expect(deadlineSentence({ remainingMs: 60_000 })).toBe("If nobody answers in 1:00, this call won't run.");
  });

  it('explains a window stretched by a slow step', () => {
    expect(deadlineSentence({ remainingMs: 60_000, timeoutMs: 44 * 60_000, basis: 'adaptive' })).toContain(
      'a step here has taken up to 22 min',
    );
  });
});
