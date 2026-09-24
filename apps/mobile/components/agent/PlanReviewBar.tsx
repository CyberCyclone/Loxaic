import { ChevronUp, ClipboardList, MessageCircleQuestion } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { ReviewItem } from '@/lib/plan';
import type { ReviewStatus } from '@/hooks/useReview';

interface PlanReviewBarProps {
  /** The newest plan or question set, which is waiting on the user. */
  item: ReviewItem;
  /** Its status — for a plan, pending or changes requested. */
  status: ReviewStatus | null;
  /** A run is going in this conversation — after a suggestion, the revision. */
  busy: boolean;
  onOpen: () => void;
}

/**
 * The plan or questions still waiting on the user, kept in view above the
 * toolbar once the panel is closed (#199).
 *
 * A closed panel must not mean a forgotten decision: the agent will not act
 * until the plan is accepted or rejected, or the questions answered. Tapping
 * it reopens the newest.
 */
export function PlanReviewBar({ item, status, busy, onOpen }: PlanReviewBarProps) {
  const questions = item.kind === 'questions';
  const revising = !questions && status === 'changes' && busy;
  const label = questions
    ? 'Questions waiting for your answers'
    : revising
      ? 'Revising the plan…'
      : status === 'pending'
        ? 'Plan ready for review'
        : 'Plan waiting for a decision';
  const title = questions ? item.questions.title : item.plan.title;
  return (
    <Pressable
      testID="agent.plan.bar"
      onPress={onOpen}
      accessibilityLabel={questions ? 'Open the questions' : 'Open the proposed plan'}
      className="mx-3 mt-2 flex-row items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 web:hover:bg-primary/15"
    >
      {revising ? (
        <Spinner size="small" />
      ) : (
        <Icon as={questions ? MessageCircleQuestion : ClipboardList} size="sm" className="text-primary" />
      )}
      <VStack className="min-w-0 flex-1">
        <Text testID="agent.plan.bar.label" size="xs" className="font-medium text-primary">
          {label}
        </Text>
        <Text size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
          {title}
        </Text>
      </VStack>
      <HStack className="shrink-0 items-center">
        <Icon as={ChevronUp} size="sm" className="text-primary" />
      </HStack>
    </Pressable>
  );
}
