import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import type { PromptStats } from '@loxaic/api-client';
import { promptProgressSegments } from '@/lib/promptStats';

/**
 * How far the backend has got evaluating the prompt, as it reported it: the
 * part it reused from its cache, then what it has evaluated since. Rendered
 * only for a measurement — an estimate stays a sentence, since a bar that
 * moved on a guess would claim exactly what the estimate line refuses to.
 *
 * Percentage widths for the reason ContextBar gives: Yoga and CSS disagree
 * about a flex-grow sum below 1. Semantic tokens only.
 */
export function PromptProgressBar({ stats }: { stats: PromptStats }) {
  const segments = promptProgressSegments(stats);
  if (!segments) return null;
  return (
    <HStack testID="chat.status.promptProgress" className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
      <Box className="bg-muted-foreground/50" style={{ width: (String(segments.cachedPct) + '%') as `${number}%` }} />
      <Box className="bg-primary" style={{ width: (String(segments.evaluatedPct) + '%') as `${number}%` }} />
    </HStack>
  );
}
