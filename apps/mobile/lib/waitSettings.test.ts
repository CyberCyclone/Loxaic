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
  it('says the check-in will keep going, and where it is on the ladder', () => {
    expect(
      deadlineSentence({ kind: 'checkin', remainingMs: 581_000, onTimeout: 'continue', unattended: 0, autoContinues: 2 }),
    ).toBe("If nobody answers in 9:41, I'll keep going (1 of 2).");
  });

  it('says it will wrap up at the end of the ladder', () => {
    expect(deadlineSentence({ kind: 'checkin', remainingMs: 60_000, onTimeout: 'answer' })).toBe(
      "If nobody answers in 1:00, I'll wrap up with what I have.",
    );
  });

  it('says an approval will not run', () => {
    expect(deadlineSentence({ kind: 'approval', remainingMs: 60_000 })).toBe("If nobody answers in 1:00, this call won't run.");
  });

  it('explains a window stretched by a slow step', () => {
    expect(
      deadlineSentence({ kind: 'approval', remainingMs: 60_000, timeoutMs: 44 * 60_000, basis: 'adaptive' }),
    ).toContain('a step here has taken up to 22 min');
  });
});
