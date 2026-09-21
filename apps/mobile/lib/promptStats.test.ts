import { describe, expect, it } from 'vitest';
import type { PromptStats } from '@loxaic/api-client';
import { describePromptStats, foldPromptStats, formatTokens } from './promptStats';

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
