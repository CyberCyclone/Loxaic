import type { ContextCategory } from '@/lib/types';

/**
 * One colour per context category, shared by the stacked bar and the legend
 * dots so a segment and its row are unmistakably the same thing.
 *
 * Semantic tokens only — these are plain Views, not SVG, so unlike ContextRing
 * there's no reason to reach for literal hex. Alpha variants give the tiers
 * enough separation without inventing palette entries.
 */
export const SEGMENT_CLASS: Record<ContextCategory | 'free' | 'used', string> = {
  // Stand-in for the whole occupied window when no per-category breakdown
  // exists yet (a turn from before the feature, or one the backend reported
  // no usage for). Bar-only — never appears as a legend row.
  used: 'bg-primary',
  system: 'bg-muted-foreground',
  tools: 'bg-warning',
  // A summary replaces what would otherwise be a much larger `history` slice
  // — success's hue reads as "space reclaimed", at half-opacity so it's
  // distinct from tool_io's full-opacity success. `bg-secondary` was
  // rejected: at rgb(244,244,245) it sits almost on top of bg-muted's
  // rgb(228,228,231), which is exactly the invisible-segment bug fixed
  // elsewhere in this feature (see ContextBar's `free` filtering).
  summary: 'bg-success/50',
  history: 'bg-primary',
  reasoning: 'bg-primary/50',
  tool_io: 'bg-success',
  current: 'bg-primary/25',
  response: 'bg-secondary-foreground',
  free: 'bg-muted',
};
