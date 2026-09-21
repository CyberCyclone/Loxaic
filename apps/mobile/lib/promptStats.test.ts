import { describe, expect, it } from 'vitest';
import type { PromptStats } from '@loxaic/api-client';
import { describePromptStats, foldPromptStats, formatTokens, loadingAfter, promptProgressSegments, showPromptStats } from './promptStats';

const stats: PromptStats = {
  message_id: 'a1',
  prompt_tokens_est: 83_700,
  est_basis: 'estimate',
  reusable_tokens: 0,
  window_tokens: 131_072,
  eta_ms: 420_000,
  started_at: 1,
};

describe('describePromptStats', () => {
  it('reads like the beta turn that started this', () => {
    expect(describePromptStats(stats)).toBe('~84k tokens · 0% reusable · about 7 min (estimate)');
  });

  it('says "up to about" when reuse is unknown, and claims no percentage', () => {
    expect(describePromptStats({ ...stats, reusable_tokens: null })).toBe('~84k tokens · up to about 7 min (estimate)');
  });

  it('floors the reuse percentage', () => {
    expect(describePromptStats({ ...stats, prompt_tokens_est: 1000, reusable_tokens: 996, eta_ms: 200 })).toBe(
      '~1.0k tokens · 99% reusable · about 1 s (estimate)',
    );
  });

  it('shows size alone with no rate yet', () => {
    expect(describePromptStats({ ...stats, eta_ms: null })).toBe('~84k tokens · 0% reusable (estimate)');
  });
});

describe('formatTokens', () => {
  it('abbreviates', () => {
    expect(formatTokens(640)).toBe('640');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(83_700)).toBe('84k');
  });
});

describe('foldPromptStats', () => {
  it('is set by the event and cleared by that message\'s first output', () => {
    const { message_id, ...rest } = stats;
    const set = foldPromptStats(null, { kind: 'prompt.stats', message_id, ...rest });
    expect(set).toEqual(stats);
    expect(foldPromptStats(set, { kind: 'text.delta', message_id: 'other', text: 'x' })).toBe(set);
    expect(foldPromptStats(set, { kind: 'thinking.delta', message_id: 'a1', text: 'x' })).toBeNull();
    expect(foldPromptStats(set, { kind: 'message.end', message_id: 'a1', status: 'complete' })).toBeNull();
  });
});

describe('showPromptStats', () => {
  it('shows through a model load, where the wait is longest', () => {
    // No `loadingModel` input at all: a gate on it made the line unreachable
    // for every run that JIT-loads, since both clear on the same event.
    expect(showPromptStats({ promptStats: stats })).toBe(true);
  });

  it('shows a load-time event without its ETA', () => {
    expect(describePromptStats({ ...stats, eta_ms: null })).not.toContain('about');
  });

  it('stays out of the way while queued or compacting, and with nothing to show', () => {
    expect(showPromptStats({ promptStats: stats, queuePosition: 2 })).toBe(false);
    expect(showPromptStats({ promptStats: stats, compacting: true })).toBe(false);
    expect(showPromptStats({ promptStats: null })).toBe(false);
  });
});

describe('measured progress', () => {
  const measured: PromptStats = {
    ...stats,
    progress: { total_tokens: 12_000, cached_tokens: 4_000, processed_tokens: 7_200, elapsed_ms: 4_000, remaining_ms: 6_000 },
  };

  it('replaces the estimate with the backend’s figures, and says none of them is an estimate', () => {
    // 3,200 of the 8,000 uncached tokens evaluated: 40%, not 60% of the whole.
    expect(describePromptStats(measured)).toBe('12k tokens · 33% cached · 40% evaluated · about 6 s left');
  });

  it('omits the countdown until the backend has a rate, and a zero cache', () => {
    const p = { total_tokens: 900, cached_tokens: 0, processed_tokens: 0, elapsed_ms: 0, remaining_ms: null };
    expect(describePromptStats({ ...stats, progress: p })).toBe('900 tokens · 0% evaluated');
  });

  it('reads 100% evaluated when the whole prompt was cached', () => {
    const p = { total_tokens: 900, cached_tokens: 900, processed_tokens: 900, elapsed_ms: 5, remaining_ms: null };
    expect(describePromptStats({ ...stats, progress: p })).toBe('900 tokens · 100% cached · 100% evaluated');
  });

  it('gives the bar its two segments as shares of the whole prompt', () => {
    expect(promptProgressSegments(measured)).toEqual({ cachedPct: 33, evaluatedPct: 26 });
    expect(promptProgressSegments(stats)).toBeNull();
  });

  it('fills the bar at completion — two independent floors would stop at 99%', () => {
    // 4,000 of 12,000 cached: 33.3% and 66.6% each floor down, to 99 between them.
    const p = { total_tokens: 12_000, cached_tokens: 4_000, processed_tokens: 12_000, elapsed_ms: 8_000, remaining_ms: null };
    expect(promptProgressSegments({ ...stats, progress: p })).toEqual({ cachedPct: 33, evaluatedPct: 67 });
  });

  it('claims no time left on a finished prefill, even from a server that sent 0', () => {
    const p = { total_tokens: 12_000, cached_tokens: 4_000, processed_tokens: 12_000, elapsed_ms: 8_000, remaining_ms: 0 };
    expect(describePromptStats({ ...stats, progress: p })).toBe('12k tokens · 33% cached · 100% evaluated');
  });

  it('never lets the segments exceed the track', () => {
    const p = { total_tokens: 3, cached_tokens: 2, processed_tokens: 3, elapsed_ms: 1, remaining_ms: null };
    const s = promptProgressSegments({ ...stats, progress: p });
    expect((s?.cachedPct ?? 0) + (s?.evaluatedPct ?? 0)).toBeLessThanOrEqual(100);
    expect(s?.cachedPct).toBe(66);
  });

  it('leaves the estimate line exactly as it was without progress', () => {
    expect(describePromptStats(stats)).toBe('~84k tokens · 0% reusable · about 7 min (estimate)');
  });
});

describe('loadingAfter', () => {
  const ev = { kind: 'prompt.stats' as const, ...stats };
  it('holds a model load through a plain prompt.stats', () => {
    expect(loadingAfter(true, ev)).toBe(true);
  });
  it('ends it on measured progress, which only a loaded model can report', () => {
    expect(loadingAfter(true, { ...ev, progress: { total_tokens: 1, cached_tokens: 0, processed_tokens: 0, elapsed_ms: 0, remaining_ms: null } })).toBe(false);
  });
  it('starts on model.loading and ends on output', () => {
    expect(loadingAfter(false, { kind: 'model.loading', message_id: 'a1' })).toBe(true);
    expect(loadingAfter(true, { kind: 'text.delta', message_id: 'a1', text: 'x' })).toBe(false);
  });
});
