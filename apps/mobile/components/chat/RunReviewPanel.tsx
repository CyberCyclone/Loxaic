import { Activity } from 'lucide-react-native';
import type { RunReview } from '@loxaic/api-client';
import { ReviewSheet } from '@/components/agent/ReviewSheet';
import { reviewCardView } from '@/lib/progressReview';
import type { ReviewDetailState } from '@/hooks/useRunReviewDetail';
import { RunReviewDetails } from './RunReviewDetails';

interface RunReviewPanelProps {
  /** The review shown, or null for closed. */
  review: RunReview | null;
  detail: ReviewDetailState;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * A progress review, opened from its card in a thread: a bottom panel, as a
 * sub-agent's is, on the same sheet (`ReviewSheet`). Nothing to decide here;
 * the review already did. It is for reading what it saw and why it said what
 * it said.
 */
export function RunReviewPanel({ review, detail, onRetry, onClose }: RunReviewPanelProps) {
  return (
    <ReviewSheet
      open={review !== null}
      onClose={onClose}
      testIDBase="review"
      icon={Activity}
      eyebrow="Progress check"
      title={review ? reviewCardView(review).title : ''}
    >
      {review ? <RunReviewDetails review={review} detail={detail} onRetry={onRetry} /> : null}
    </ReviewSheet>
  );
}
