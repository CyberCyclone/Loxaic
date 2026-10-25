import { describe, expect, it } from 'vitest';
import type { PromptCacheStatus, PromptCacheView } from '@loxaic/api-client';
import {
  BANNER_MIN_TOKENS,
  foldPromptCache,
  promptCacheActive,
  promptCacheBanner,
  promptCacheBar,
  promptCacheLabel,
} from './promptCache';

const status = (over: Partial<PromptCacheStatus> = {}): PromptCacheStatus => ({
  message_id: 'm1',
  step: 'restoring',
  tokens: 180_000,
  bytes_total: 3_000,
  bytes_done: 1_896,
  estimated: false,
  started_at: 1,
  ...over,
});

describe('foldPromptCache', () => {
  it('takes each prompt.cache event and drops it at its reply’s first output', () => {
    const s = foldPromptCache(null, { kind: 'prompt.cache', ...status() });
    expect(s).toEqual(status());
    for (const kind of ['text.delta', 'thinking.delta'] as const) {
      expect(foldPromptCache(s, { kind, message_id: 'm1', text: 'x' }), kind).toBeNull();
    }
    expect(foldPromptCache(s, { kind: 'message.end', message_id: 'm1', status: 'complete' })).toBeNull();
    // Another message's output, or anything else, leaves it.
    expect(foldPromptCache(s, { kind: 'text.delta', message_id: 'm2', text: 'x' })).toBe(s);
    expect(foldPromptCache(s, { kind: 'run.queued', position: 1 })).toBe(s);
  });
});

describe('the pill', () => {
  it('says how far a restore has read, floored, and "about" when estimated', () => {
    expect(promptCacheLabel(status())).toBe('Loading cached context · 63%');
    expect(promptCacheLabel(status({ estimated: true }))).toBe('Loading cached context · about 63%');
    expect(promptCacheLabel(status({ bytes_done: 2_999 }))).toBe('Loading cached context · 99%');
    expect(promptCacheLabel(status({ bytes_total: 0 }))).toBe('Loading cached context');
    expect(promptCacheActive(status())).toBe(true);
  });

  it('says when it is loaded, or that it could not be and the turn re-reads', () => {
    expect(promptCacheLabel(status({ step: 'restored' }))).toBe('Cached context loaded · 180k tokens');
    expect(promptCacheLabel(status({ step: 'failed' }))).toBe("Couldn't load the cached context, so it is re-read");
    expect(promptCacheActive(status({ step: 'restored' }))).toBe(false);
  });

  it('draws the shared bar from the bytes read, only while reading', () => {
    expect(promptCacheBar(status())?.progress).toMatchObject({ total_tokens: 3_000, processed_tokens: 1_896, cached_tokens: 0 });
    expect(promptCacheBar(status({ step: 'restored' }))).toBeNull();
    expect(promptCacheBar(status({ bytes_total: 0 }))).toBeNull();
  });
});

describe('promptCacheBanner', () => {
  const lost: PromptCacheView = { state: 'lost', reason: 'settings', tokens: 210_000, reread_seconds: 720 };
  const input = (over: Partial<Parameters<typeof promptCacheBanner>[0]> = {}) => ({
    conversationId: 'c1',
    view: lost,
    modelName: 'Flash-Next',
    running: false,
    dismissed: new Set<string>(),
    ...over,
  });

  it('says why the cache is gone and what the next message costs', () => {
    expect(promptCacheBanner(input())?.text).toBe(
      "Flash-Next was reloaded with new settings since this conversation's last reply, so its prompt cache is gone. Your next message re-reads all 210k tokens (about 12 min).",
    );
    expect(promptCacheBanner(input({ view: { ...lost, reason: 'context_stage', reread_seconds: null } }))?.text).toContain(
      'reloaded at a different context size',
    );
    expect(promptCacheBanner(input({ view: { ...lost, reason: 'context_stage', reread_seconds: null } }))?.text).toMatch(/210k tokens\.$/);
  });

  it('says it was the disk when the save was skipped for want of it, with the figures', () => {
    const skipped: PromptCacheView = { ...lost, reason: 'no_disk', need_bytes: 3.1 * 1024 ** 3, free_bytes: 300 * 1024 ** 2 };
    expect(promptCacheBanner(input({ view: skipped }))?.text).toBe(
      "Flash-Next was reloaded, and the server didn't have the disk space to keep this conversation's prompt cache " +
        '(it needed about 3.1 GB, and 300 MB was free). Your next message re-reads all 210k tokens (about 12 min).',
    );
    // Small figures stay themselves, never rounded up into each other.
    expect(promptCacheBanner(input({ view: { ...skipped, need_bytes: 832 * 1024, free_bytes: 1 } }))?.text).toContain(
      '(it needed about 832 KB, and 1 B was free)',
    );
    // An older server's no_disk carries no figures: the sentence still stands.
    expect(promptCacheBanner(input({ view: { ...lost, reason: 'no_disk' } }))?.text).toMatch(/disk space to keep this conversation's prompt cache\. Your next/);
  });

  it('says nothing when the cache is not certainly gone, or the re-read is short', () => {
    for (const view of [null, { state: 'none' }, { state: 'warm' }, { state: 'saved', tokens: 210_000 }] as (PromptCacheView | null)[]) {
      expect(promptCacheBanner(input({ view })), JSON.stringify(view)).toBeNull();
    }
    expect(promptCacheBanner(input({ view: { ...lost, tokens: BANNER_MIN_TOKENS - 1 } }))).toBeNull();
  });

  it('goes while a reply runs, and stays gone once dismissed for this loss', () => {
    expect(promptCacheBanner(input({ running: true }))).toBeNull();
    const shown = promptCacheBanner(input());
    expect(shown).not.toBeNull();
    expect(promptCacheBanner(input({ dismissed: new Set([shown?.key ?? '']) }))).toBeNull();
    // A later, different loss is said again.
    expect(promptCacheBanner(input({ dismissed: new Set([shown?.key ?? '']), view: { ...lost, reason: 'restart' } }))).not.toBeNull();
  });
});
