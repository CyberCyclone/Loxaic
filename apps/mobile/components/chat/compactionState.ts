import type { CompactionStats } from '@/lib/types';

export type CompactionCardState = 'failed' | 'skipped' | 'live' | 'done';

/**
 * Which face a summary card shows. Kept out of the component so it can be
 * tested without rendering one.
 *
 * `failed` is checked first because a failed summary row has no stats either:
 * no `compaction` block is ever written for it, and "no stats" used to be the
 * whole definition of live — so a failed `/compact` reloaded as a card
 * spinning on "Compacting…" forever.
 */
export function compactionCardState(stats: CompactionStats | undefined, failed: boolean | undefined): CompactionCardState {
  if (failed) return 'failed';
  if (stats?.skipped) return 'skipped';
  return stats ? 'done' : 'live';
}
