import type { RunReview } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { useServerReachable } from '@/lib/connection';
import { isReviewRunning, reviewPanelRows } from '@/lib/progressReview';
import type { ReviewDetailState } from '@/hooks/useRunReviewDetail';

interface RunReviewDetailsProps {
  review: RunReview;
  /** Its full record — see useRunReviewDetail. */
  detail: ReviewDetailState;
  onRetry: () => void;
}

/**
 * Everything one progress review has to show: what it found and why, what
 * was done, how and when it ran, what the request cost, and the digest the
 * reviewer read. The body of the review's own panel on a thread, and of a
 * sub-agent's panel when one of its reviews is opened there.
 *
 * The rows the card already knows are shown at once; the cost and the digest
 * arrive with the record. Each value has its own testID (`review.panel.<row>`).
 */
export function RunReviewDetails({ review, detail, onRetry }: RunReviewDetailsProps) {
  const reachable = useServerReachable();
  const rows = reviewPanelRows(review, detail.detail);
  const running = isReviewRunning(review);
  return (
    <VStack space="md">
      {rows.map((row) => (
        <VStack key={row.key} space="xs">
          <Text size="2xs" className="uppercase text-muted-foreground">
            {row.label}
          </Text>
          <Text testID={`review.panel.${row.key}`} size="sm" className="text-foreground">
            {row.value}
          </Text>
        </VStack>
      ))}
      {running ? (
        <Text testID="review.panel.pending" size="xs" className="text-muted-foreground">
          The rest is shown when the check ends.
        </Text>
      ) : null}
      {detail.status === 'loading' ? (
        <HStack space="sm" className="items-center">
          <Spinner size="small" className="text-muted-foreground" />
          <Text testID="review.panel.loading" size="xs" className="text-muted-foreground">
            Loading the details…
          </Text>
        </HStack>
      ) : null}
      {detail.status === 'failed' ? (
        <VStack space="xs">
          <Text testID="review.panel.failed" size="xs" className="text-muted-foreground">
            Couldn’t load the rest of this check.
          </Text>
          <DisconnectedNote testID="review.panel.reconnecting" what="load it" />
          <Pressable
            testID="review.panel.retry"
            accessibilityLabel="Try loading the details again"
            disabled={!reachable}
            onPress={onRetry}
            className={`self-start rounded-full bg-muted px-3 py-1.5 web:hover:bg-muted/80 ${reachable ? '' : 'opacity-50'}`}
          >
            <Text size="xs" className="text-muted-foreground">
              Try again
            </Text>
          </Pressable>
        </VStack>
      ) : null}
      {detail.status === 'loaded' && detail.detail.digest ? (
        <VStack space="xs">
          <Text size="2xs" className="uppercase text-muted-foreground">
            What the reviewer read
          </Text>
          <Box className="rounded-md border border-border bg-muted/40 p-3">
            <Text testID="review.panel.digest" selectable className="text-[12px] leading-[18px] text-foreground font-mono">
              {detail.detail.digest}
            </Text>
          </Box>
        </VStack>
      ) : null}
    </VStack>
  );
}
