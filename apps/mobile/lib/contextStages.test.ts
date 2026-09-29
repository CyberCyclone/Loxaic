import { describe, expect, it } from 'vitest';
import type { ModelContextStage } from '@loxaic/types';
import {
  approachingKey,
  formatAgo,
  formatExtraMemory,
  formatRereadTime,
  formatWindow,
  mayChangeStage,
  needsCompactFirst,
  nextStage,
  othersWarning,
  shouldPromptApproaching,
  shouldPromptStepDown,
  stageFill,
  stageLabel,
  stepDownKey,
  stepDownTarget,
} from './contextStages';

const K = 1024;
const stage = (over: Partial<ModelContextStage> = {}): ModelContextStage => ({
  active: 0,
  windows: [256 * K, 512 * K, 1024 * K],
  pending: null,
  who_may_change: 'everyone',
  when_full: 'compact',
  ...over,
});

describe('window names', () => {
  it('reads like the ring does', () => {
    expect(formatWindow(262144)).toBe('256K');
    expect(formatWindow(786432)).toBe('768K');
    expect(formatWindow(1048576)).toBe('1M');
    expect(formatWindow(1572864)).toBe('1.5M');
    expect(formatWindow(512)).toBe('512');
    expect(formatWindow(null)).toBe('unknown');
    expect(stageLabel(524288, 2, false)).toBe('512K · YaRN 2×');
    expect(stageLabel(262144, null, true)).toBe('256K · standard');
    // A bigger stage that needs no YaRN is just its size.
    expect(stageLabel(81920, null, false)).toBe('80K');
  });
});

describe('approaching the limit', () => {
  const base = { stage: stage(), usedTokens: 200 * K, streaming: false, readOnly: false, shown: new Set<string>(), conversationId: 'c1' };

  it('asks once the conversation passes 75% of the stage it is at', () => {
    expect(shouldPromptApproaching(base)).toBe(true);
    expect(shouldPromptApproaching({ ...base, usedTokens: 190 * K })).toBe(false); // 74%
    expect(shouldPromptApproaching({ ...base, usedTokens: 192 * K })).toBe(true); // 75%
  });

  it('measures against the current stage, so it is quiet right after an extension', () => {
    // 200K used of 256K would ask; the same 200K at the 512K stage is 39%.
    expect(stageFill(200 * K, stage({ active: 1 }))).toBeCloseTo(0.39, 2);
    expect(shouldPromptApproaching({ ...base, stage: stage({ active: 1 }) })).toBe(false);
  });

  it('never asks mid-reply, on a read-only thread, or without a conversation', () => {
    expect(shouldPromptApproaching({ ...base, streaming: true })).toBe(false);
    expect(shouldPromptApproaching({ ...base, readOnly: true })).toBe(false);
    expect(shouldPromptApproaching({ ...base, conversationId: null })).toBe(false);
    expect(shouldPromptApproaching({ ...base, stage: undefined })).toBe(false);
  });

  it('stays quiet for a model that extends by itself, and at the last stage', () => {
    expect(shouldPromptApproaching({ ...base, stage: stage({ when_full: 'extend' }) })).toBe(false);
    expect(nextStage(stage({ active: 2 }))).toBeNull();
    expect(shouldPromptApproaching({ ...base, stage: stage({ active: 2 }), usedTokens: 900 * K })).toBe(false);
  });

  it('asks once per conversation per stage', () => {
    const shown = new Set([approachingKey('c1', 0)]);
    expect(shouldPromptApproaching({ ...base, shown })).toBe(false);
    // Another conversation, or the same one at the next stage, asks again.
    expect(shouldPromptApproaching({ ...base, shown, conversationId: 'c2' })).toBe(true);
    expect(shouldPromptApproaching({ ...base, shown, stage: stage({ active: 1 }), usedTokens: 400 * K })).toBe(true);
  });

  it('still asks when the person cannot extend (Compact is what they get)', () => {
    expect(mayChangeStage(stage({ who_may_change: 'admins' }), false)).toBe(false);
    expect(mayChangeStage(stage({ who_may_change: 'admins' }), true)).toBe(true);
    expect(shouldPromptApproaching({ ...base, stage: stage({ who_may_change: 'admins' }) })).toBe(true);
  });
});

describe('stepping back down', () => {
  const info = { recommended: 0, may_change: true, blocked_down_to: 0 };
  const base = { stage: stage({ active: 2 }), info, conversationId: 'c1', readOnly: false, shown: new Set<string>() };

  it('offers it when the conversation needs less than the model is at', () => {
    expect(shouldPromptStepDown(base)).toBe(true);
    expect(stepDownTarget(info)).toBe(0);
  });

  it('offers only as far down as other conversations allow, and nothing when they hold it', () => {
    expect(stepDownTarget({ recommended: 0, blocked_down_to: 1 })).toBe(1);
    expect(shouldPromptStepDown({ ...base, info: { ...info, blocked_down_to: 1 } })).toBe(true);
    expect(shouldPromptStepDown({ ...base, info: { ...info, blocked_down_to: 2 } })).toBe(false);
  });

  it('is quiet at standard, when the conversation needs the stage, or the person may not change it', () => {
    expect(shouldPromptStepDown({ ...base, stage: stage({ active: 0 }) })).toBe(false);
    expect(shouldPromptStepDown({ ...base, info: { ...info, recommended: 2 } })).toBe(false);
    expect(shouldPromptStepDown({ ...base, info: { ...info, may_change: false } })).toBe(false);
    expect(shouldPromptStepDown({ ...base, readOnly: true })).toBe(false);
    expect(shouldPromptStepDown({ ...base, info: null })).toBe(false);
  });

  it('asks once per conversation per stage', () => {
    expect(shouldPromptStepDown({ ...base, shown: new Set([stepDownKey('c1', 2)]) })).toBe(false);
  });
});

describe('a stage smaller than the conversation', () => {
  it('needs compacting first at 85% of the target window', () => {
    expect(needsCompactFirst(600 * K, 512 * K)).toBe(true);
    expect(needsCompactFirst(300 * K, 512 * K)).toBe(false);
    expect(needsCompactFirst(0.85 * 512 * K, 512 * K)).toBe(true);
    // Not knowing is not a reason to stop someone.
    expect(needsCompactFirst(null, 512 * K)).toBe(false);
    expect(needsCompactFirst(600 * K, null)).toBe(false);
  });
});

describe('what a switch does to everyone else', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();

  it('says nothing when nobody else has used the model lately', () => {
    expect(othersWarning({ count: 0, last_used_at: null, running: 0 }, now)).toBeNull();
  });

  it('says who is affected and when it was last used, never who they are', () => {
    const w = othersWarning({ count: 2, last_used_at: ago(4), running: 0 }, now);
    expect(w?.text).toBe(
      '2 other conversations are using this model, last used 4 minutes ago. Switching reloads it for them too: their next reply re-reads their conversation.',
    );
    expect(w?.waits).toBe(false);
    expect(othersWarning({ count: 1, last_used_at: ago(0), running: 0 }, now)?.text).toMatch(/^1 other conversation is using this model, last used just now/);
  });

  it('says the switch waits when another conversation is replying right now', () => {
    const w = othersWarning({ count: 2, last_used_at: ago(1), running: 1 }, now);
    expect(w?.waits).toBe(true);
    expect(w?.text).toMatch(/1 is replying right now, so the switch will wait until it finishes\.$/);
    expect(othersWarning({ count: 3, last_used_at: ago(1), running: 2 }, now)?.text).toMatch(/2 are replying right now, so the switch will wait until they finish\.$/);
  });

  it('phrases time the way a person would', () => {
    expect(formatAgo(ago(0.2), now)).toBe('just now');
    expect(formatAgo(ago(1), now)).toBe('a minute ago');
    expect(formatAgo(ago(59), now)).toBe('59 minutes ago');
    expect(formatAgo(ago(60), now)).toBe('an hour ago');
    expect(formatAgo(ago(120), now)).toBe('2 hours ago');
    expect(formatAgo(null, now)).toBeNull();
  });
});

describe('the cost lines', () => {
  it('re-read time and memory', () => {
    expect(formatRereadTime(null)).toBeNull();
    expect(formatRereadTime(2)).toBe('a few seconds');
    expect(formatRereadTime(40)).toBe('about 40 s');
    expect(formatRereadTime(300)).toBe('about 5 min');
    expect(formatExtraMemory(0)).toBeNull();
    expect(formatExtraMemory(6.4 * 1024 ** 3)).toBe('about 6.4 GB more memory');
    expect(formatExtraMemory(48 * 1024 ** 3)).toBe('about 48 GB more memory');
  });
});
