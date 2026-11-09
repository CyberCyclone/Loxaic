import type { ReviewMode } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { reviewStatusText } from '@/lib/progressReview';

/**
 * A quiet line while a progress review of the run is under way. Nothing to
 * press: the review decides on its own, and says what it did in the thread.
 * The testID is on the Text — XCUITest does not expose a plain container's.
 */
export function ReviewStatus({ mode }: { mode: ReviewMode | null | undefined }) {
  const text = reviewStatusText(mode);
  if (!text) return null;
  return (
    <Box className="border-t border-border px-4 py-1.5">
      <Text testID="run.review.status" size="2xs" className="text-muted-foreground">
        {text}
      </Text>
    </Box>
  );
}
