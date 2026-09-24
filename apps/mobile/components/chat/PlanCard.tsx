import { createContext, useContext } from 'react';
import { ClipboardList } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { PLAN_TOOL, planTitle, type PlanStatus } from '@/lib/plan';
import type { ToolCall } from '@/lib/types';
import { ToolCallCard } from './ToolCallCard';

/**
 * How a plan in the transcript reaches the panel that shows it (#199). A
 * context rather than props because the card sits under MessageList →
 * Message, which Chat shares and which has no planning mode: without a
 * provider a plan call simply renders as the ordinary tool card.
 */
export interface PlanReview {
  open: (callId: string) => void;
  statusOf: (callId: string) => PlanStatus | null;
}

export const PlanReviewContext = createContext<PlanReview | null>(null);

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: 'Awaiting review',
  changes: 'Changes requested',
  accepted: 'Accepted',
  rejected: 'Rejected',
  superseded: 'Replaced by a newer plan',
};

const STATUS_TINT: Record<PlanStatus, string> = {
  pending: 'text-warning',
  changes: 'text-warning',
  accepted: 'text-success',
  rejected: 'text-destructive',
  superseded: 'text-muted-foreground',
};

/** A tool call in the transcript: a plan card when it is a plan this screen
 * can show, the ordinary card otherwise. */
export function ToolOrPlanCard({ tool }: { tool: ToolCall }) {
  const review = useContext(PlanReviewContext);
  if (review && tool.tool === PLAN_TOOL && tool.plan && tool.callId && tool.ok === true) {
    return <PlanCard callId={tool.callId} plan={tool.plan} review={review} />;
  }
  return <ToolCallCard tool={tool} />;
}

/**
 * A plan, in the transcript. Deliberately not the plan itself: it is read in
 * the panel, where it has the room, and repeating it here would put back the
 * wall of text in the thread that #199 was about.
 */
function PlanCard({ callId, plan, review }: { callId: string; plan: string; review: PlanReview }) {
  const status = review.statusOf(callId);
  return (
    <Box testID={`chat.plan.${callId}`} className="my-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
      <HStack space="sm" className="min-w-0 items-center">
        <Icon as={ClipboardList} size="sm" className="text-primary" />
        <VStack className="min-w-0 flex-1">
          <Text size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {planTitle(plan)}
          </Text>
          <Text testID={`chat.plan.status.${callId}`} size="2xs" className={status ? STATUS_TINT[status] : 'text-muted-foreground'}>
            {status ? `Proposed plan · ${STATUS_LABEL[status]}` : 'Proposed plan'}
          </Text>
        </VStack>
        <Pressable
          testID={`chat.plan.open.${callId}`}
          onPress={() => { review.open(callId); }}
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 web:hover:bg-primary/90"
        >
          <Text size="xs" className="font-medium text-primary-foreground">
            {status === 'pending' ? 'Review plan' : 'View plan'}
          </Text>
        </Pressable>
      </HStack>
    </Box>
  );
}
