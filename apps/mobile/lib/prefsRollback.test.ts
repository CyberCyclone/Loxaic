import { describe, expect, it } from 'vitest';
import type { UserPrefs } from '@loxaic/api-client';
import { revertPatch } from './prefsRollback';

const before: UserPrefs = { toolAllowlist: [], progressCheckSteps: 20, progressCheckMs: null };

describe('revertPatch', () => {
  it('puts back only what the failed save touched', () => {
    // Save #1 (50 steps) is in flight; save #2 (30 min) has already landed.
    const current: UserPrefs = { ...before, progressCheckSteps: 50, progressCheckMs: 1_800_000 };
    expect(revertPatch(current, before, { progressCheckSteps: 50 })).toEqual({
      ...before,
      progressCheckMs: 1_800_000,
    });
  });

  it('restores null as null — it means the server default, not a missing value', () => {
    const current: UserPrefs = { ...before, progressCheckMs: 60_000 };
    expect(revertPatch(current, before, { progressCheckMs: 60_000 }).progressCheckMs).toBeNull();
  });

  it('falls back to the snapshot when there is nothing current', () => {
    expect(revertPatch(null, before, { progressCheckSteps: 100 })).toBe(before);
  });
});
