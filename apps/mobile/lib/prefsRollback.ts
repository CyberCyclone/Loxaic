import type { UserPrefs } from '@loxaic/api-client';

/**
 * Undo one failed save without touching anything else.
 *
 * Only the fields *that* save patched go back to what they were before it.
 * Restoring the whole pre-save snapshot instead also undoes a later save that
 * succeeded: tap "Relaxed", then "30 min" before the first request returns,
 * have the first one fail, and the 30-minute chip vanished from a screen whose
 * server had stored it.
 */
export function revertPatch(current: UserPrefs | null, previous: UserPrefs, patch: Partial<UserPrefs>): UserPrefs {
  if (!current) return previous;
  const reverted: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as (keyof UserPrefs)[]) reverted[key] = previous[key];
  return reverted as unknown as UserPrefs;
}
