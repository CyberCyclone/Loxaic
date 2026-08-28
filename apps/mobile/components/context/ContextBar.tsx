import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import type { ContextSegment } from '@/hooks/useContextUsage';
import { SEGMENT_CLASS } from './segments';

/**
 * Stacked proportional bar of what's occupying the context window.
 *
 * Widths are explicit percentages rather than flex factors. A flex-grow sum
 * below 1 is not treated the same way by Yoga and by CSS — one leaves the
 * remainder unfilled, the other can normalise it to full — and a bar that
 * silently reads 100% whatever the real figure is exactly the class of bug
 * this whole change exists to remove. Percentages behave identically on both.
 *
 * The width is inline because the proportions are data; there's no static
 * class for "62% wide". Every colour is a semantic token.
 */
export function ContextBar({ segments, over }: { segments: ContextSegment[]; over?: boolean }) {
  // The track already *is* the free space, so a free segment would paint
  // bg-muted onto bg-muted — invisible, and it would consume width that
  // should read as unfilled.
  const filled = segments.filter((s) => s.category !== 'free');
  if (filled.length === 0) return null;

  // Over budget the shares exceed the window, so rescale them to fill the
  // track exactly: the bar reads as full and the percentage above it carries
  // the overflow.
  const total = filled.reduce((sum, s) => sum + Math.max(s.fraction, 0), 0);
  const scale = total > 1 ? 1 / total : 1;

  return (
    <HStack
      className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${over ? 'border border-destructive' : ''}`}
    >
      {filled.map((s) => (
        <Box
          key={s.category}
          className={SEGMENT_CLASS[s.category]}
          // Built via concatenation, then narrowed with `as`, rather than a
          // template literal: RN's DimensionValue requires the literal type
          // `${number}%`, which a plain `string` (what String(n) + '%'
          // produces) doesn't structurally satisfy without this assertion.
          style={{ width: (String(Math.max(s.fraction, 0) * scale * 100) + '%') as `${number}%` }}
        />
      ))}
    </HStack>
  );
}
