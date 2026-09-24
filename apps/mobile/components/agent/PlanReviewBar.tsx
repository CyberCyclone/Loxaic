import { ChevronUp, ClipboardList } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { PlanStatus, ProposedPlan } from '@/lib/plan';

interface PlanReviewBarProps {
  plan: ProposedPlan;
  status: Extract<PlanStatus, 'pending' | 'changes'>;
  /** A run is going in this conversation — after a suggestion, the revision. */
  busy: boolean;
  onOpen: () => void;
}

/**
 * The plan that has not been accepted or rejected, kept in view above the
 * toolbar once its panel is closed or a revision has been asked for (#199).
 *
 * A closed panel must not mean a forgotten plan: the decision it asks for is
 * still outstanding, and the agent will not act until it is made. Tapping it
 * reopens the newest plan.
 */
export function PlanReviewBar({ plan, status, busy, onOpen }: PlanReviewBarProps) {
  const revising = status === 'changes' && busy;
  return (
    <Pressable
      testID="agent.plan.bar"
      onPress={onOpen}
      accessibilityLabel="Open the proposed plan"
      className="mx-3 mt-2 flex-row items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 web:hover:bg-primary/15"
    >
      {revising ? <Spinner size="small" /> : <Icon as={ClipboardList} size="sm" className="text-primary" />}
      <VStack className="min-w-0 flex-1">
        <Text testID="agent.plan.bar.label" size="xs" className="font-medium text-primary">
          {revising ? 'Revising the plan…' : status === 'pending' ? 'Plan ready for review' : 'Plan waiting for a decision'}
        </Text>
        <Text size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
          {plan.title}
        </Text>
      </VStack>
      <HStack className="shrink-0 items-center">
        <Icon as={ChevronUp} size="sm" className="text-primary" />
      </HStack>
    </Pressable>
  );
}
