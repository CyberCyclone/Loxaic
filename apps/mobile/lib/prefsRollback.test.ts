import { describe, expect, it } from 'vitest';
import type { UserPrefs } from '@loxaic/api-client';
import { revertPatch } from './prefsRollback';

const before: UserPrefs = { toolAllowlist: [], loopSensitivity: 'normal', checkinTimeoutMs: null };

describe('revertPatch', () => {
  it('puts back only what the failed save touched', () => {
    // Save #1 (relaxed) is in flight; save #2 (30 min) has already landed.
    const current: UserPrefs = { ...before, loopSensitivity: 'relaxed', checkinTimeoutMs: 1_800_000 };
    expect(revertPatch(current, before, { loopSensitivity: 'relaxed' })).toEqual({
      ...before,
      checkinTimeoutMs: 1_800_000,
    });
  });

  it('restores null as null — it means the server default, not a missing value', () => {
    const current: UserPrefs = { ...before, checkinTimeoutMs: 60_000 };
    expect(revertPatch(current, before, { checkinTimeoutMs: 60_000 }).checkinTimeoutMs).toBeNull();
  });

  it('falls back to the snapshot when there is nothing current', () => {
    expect(revertPatch(null, before, { loopSensitivity: 'off' })).toBe(before);
  });
});
