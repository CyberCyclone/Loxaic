import { describe, expect, it } from 'vitest';
import type { ContextStageStatus } from '@loxaic/api-client';
import { foldStageCard, isStageActive, reloadRemaining, shouldInstallStageSnapshot, stageCardDetail, stageCardLabel } from './stageCard';

const K = 1024;
const status = (over: Partial<ContextStageStatus> = {}): ContextStageStatus => ({
  step: 'reloading',
  reason: 'chosen',
  auto: false,
  model: 'm',
  from_stage: 0,
  to_stage: 1,
  from_tokens: 256 * K,
  to_tokens: 512 * K,
  yarn_factor: 2,
  ...over,
});
const label = (s: ContextStageStatus, now = 0, stepSince = 0) => stageCardLabel({ status: s, stepSince }, now);

describe('the pill says what is happening', () => {
  it('waits, naming why when the context filled', () => {
    expect(label(status({ step: 'waiting', running: 1 }))).toBe('Waiting for another reply to finish');
    expect(label(status({ step: 'waiting', running: 0 }))).toBe('Waiting for the model to be free');
    expect(label(status({ step: 'waiting', running: 1, reason: 'full' }))).toBe(
      'Context full — waiting for another reply to finish before enabling YaRN',
    );
  });

  it('reloads, with the time left counted down from how long it took last time', () => {
    expect(label(status())).toBe('Enabling YaRN 2× · reloading at 512K');
    expect(label(status({ reason: 'full' }))).toBe('Context full — enabling YaRN 2× · reloading at 512K');
    const s = status({ eta_ms: 40_000 });
    expect(label(s, 0, 0)).toBe('Enabling YaRN 2× · reloading at 512K · about 40 s');
    expect(label(s, 25_000, 0)).toBe('Enabling YaRN 2× · reloading at 512K · about 15 s');
    // Past the estimate: no countdown rather than a negative one.
    expect(label(s, 60_000, 0)).toBe('Enabling YaRN 2× · reloading at 512K');
    expect(reloadRemaining(s, 0, 60_000)).toBeNull();
    expect(reloadRemaining(status({ eta_ms: null }), 0, 1000)).toBeNull();
  });

  it('says a step down, to standard or to a smaller stage', () => {
    expect(label(status({ from_stage: 2, to_stage: 0, to_tokens: 256 * K, yarn_factor: null }))).toBe(
      'Switching back to standard context (256K) · reloading…',
    );
    expect(label(status({ from_stage: 2, to_stage: 1, to_tokens: 512 * K, yarn_factor: 2 }))).toBe('Switching to 512K (YaRN 2×) · reloading…');
  });

  it('re-reads with the backend’s own progress', () => {
    const progress = { total_tokens: 200_000, cached_tokens: 0, processed_tokens: 86_000, elapsed_ms: 1000, remaining_ms: 120_000 };
    expect(label(status({ step: 'rereading', progress }))).toBe('Re-reading conversation · 43% · about 2 min left');
    expect(label(status({ step: 'rereading' }))).toBe('Re-reading conversation');
    expect(label(status({ step: 'rereading', progress: { ...progress, remaining_ms: null } }))).toBe('Re-reading conversation · 43%');
  });

  it('ends applied or failed', () => {
    expect(label(status({ step: 'applied' }))).toBe('Context extended to 512K (YaRN 2×)');
    expect(label(status({ step: 'applied', from_stage: 1, to_stage: 0, to_tokens: 256 * K, yarn_factor: null }))).toBe(
      'Switched to standard context (256K)',
    );
    expect(label(status({ step: 'applied', from_stage: 1, to_stage: 1 }))).toBe('Context stays at 512K (YaRN 2×)');
    expect(label(status({ step: 'failed', message: 'llama.cpp could not load it' }))).toBe('llama.cpp could not load it');
    expect(label(status({ step: 'failed' }))).toBe('The context could not be changed.');
  });

  it('adds a line when a step has more to say', () => {
    expect(stageCardDetail(status({ step: 'applied', message: 'Another conversation still needs this much context.' }))).toBe(
      'Another conversation still needs this much context.',
    );
    expect(stageCardDetail(status({ step: 'applied', auto: true, reason: 'new-conversation', to_stage: 0 }))).toMatch(/without YaRN/);
    expect(stageCardDetail(status({ step: 'reloading' }))).toBeNull();
  });
});

describe('folding the steps of one switch', () => {
  it('keeps when the switch began, and when this step did', () => {
    const a = foldStageCard(null, 's1', status({ step: 'waiting', running: 1 }), 1000);
    expect(a).toMatchObject({ since: 1000, stepSince: 1000 });
    // Waiting is re-sent as the line moves: the same step.
    const again = foldStageCard(a, 's1', status({ step: 'waiting', running: 1 }), 2000);
    expect(again).toMatchObject({ since: 1000, stepSince: 1000 });
    const reloading = foldStageCard(again, 's1', status(), 3000);
    expect(reloading).toMatchObject({ since: 1000, stepSince: 3000 });
    // A different run is a different switch.
    expect(foldStageCard(reloading, 's2', status(), 9000)).toMatchObject({ since: 9000, stepSince: 9000 });
  });

  it('is active until it applies or fails', () => {
    expect(isStageActive(null)).toBe(false);
    expect(isStageActive(foldStageCard(null, 's', status({ step: 'rereading' }), 0))).toBe(true);
    expect(isStageActive(foldStageCard(null, 's', status({ step: 'applied' }), 0))).toBe(false);
    expect(isStageActive(foldStageCard(null, 's', status({ step: 'failed' }), 0))).toBe(false);
  });
});

describe('a reconnect replaying finished stage runs', () => {
  const card = (streamId: string) => foldStageCard(null, streamId, status({ step: 'applied' }), 0);

  it('installs the card for a run it has no card for', () => {
    expect(shouldInstallStageSnapshot({ have: undefined, dropped: new Set(), streamId: 's1', runActive: false })).toBe(true);
    expect(shouldInstallStageSnapshot({ have: null, dropped: new Set(), streamId: 's1', runActive: true })).toBe(true);
  });

  it('does not bring back a card the person dismissed by sending again', () => {
    // The card was cleared, so `have` is empty — only the remembered id tells it from a card never seen.
    expect(shouldInstallStageSnapshot({ have: undefined, dropped: new Set(['s1']), streamId: 's1', runActive: false })).toBe(false);
    // Another run's card is still welcome.
    expect(shouldInstallStageSnapshot({ have: undefined, dropped: new Set(['s1']), streamId: 's2', runActive: false })).toBe(true);
  });

  it('does not let an older finished run replace a newer card, but a live one may', () => {
    expect(shouldInstallStageSnapshot({ have: card('new'), dropped: new Set(), streamId: 'old', runActive: false })).toBe(false);
    expect(shouldInstallStageSnapshot({ have: card('new'), dropped: new Set(), streamId: 'old', runActive: true })).toBe(true);
    expect(shouldInstallStageSnapshot({ have: card('same'), dropped: new Set(), streamId: 'same', runActive: false })).toBe(true);
  });
});
