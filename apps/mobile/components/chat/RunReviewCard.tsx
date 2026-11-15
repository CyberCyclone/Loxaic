import { memo, useContext } from 'react';
import { Activity } from 'lucide-react-native';
import type { RunReview } from '@loxaic/api-client';
import { Text } from '@/components/ui/text';
import { reviewCardView } from '@/lib/progressReview';
import { RunReviewContext } from './RunReviewContext';
import { ThreadCard } from './ThreadCard';

/**
 * A progress review, in the thread at the step it was taken after: under way
 * ("Checking progress…"), or what it found and what was done about it.
 * Pressing it opens the panel with everything the review has to show.
 *
 * The card is the review. What the run was *told*, when it was told
 * anything, is the note that follows it in the thread (`progress.note`),
 * which the model reads; this card it never does.
 */
export const RunReviewCard = memo(function RunReviewCard({ review }: { review: RunReview }) {
  const ui = useContext(RunReviewContext);
  const view = reviewCardView(review);
  const base = `review.card.${review.id}`;
  return (
    <ThreadCard
      testIDBase={base}
      titleTestID={`${base}.title`}
      icon={Activity}
      title={view.title}
      openLabel={`Open progress check: ${view.title}`}
      onOpen={() => { ui?.open(review); }}
    >
      <Text testID={`${base}.meta`} size="2xs" className="text-muted-foreground">
        {view.meta}
      </Text>
    </ThreadCard>
  );
});
