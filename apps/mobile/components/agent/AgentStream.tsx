import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Box } from '@/components/ui/box';
import { MessageList } from '@/components/chat/MessageList';
import { RunHeader } from './RunHeader';
import { PlanningBanner } from './PlanningBanner';
import { PermissionBar } from './PermissionBar';
import { StepCheckInBanner } from '@/components/chat/StepCheckInBanner';
import type { Conversation, AgentMode } from '@/lib/types';
import type { RunState, PendingApproval, PendingCheckin } from '@/hooks/useAgentSession';

interface AgentStreamProps {
  run: Conversation | null;
  state: RunState;
  mode: AgentMode;
  iteration: { n: number; max: number } | null;
  loadingModel?: boolean;
  queuePosition?: number | null;
  responseStartedAt?: number | null;
  pendingApproval: PendingApproval | null;
  pendingCheckin: PendingCheckin | null;
  onAllow: () => void;
  onDeny: () => void;
  onCheckinContinue: () => void;
  onCheckinAnswer: () => void;
  onCheckinStop: () => void;
}

export function AgentStream({
  run,
  state,
  mode,
  iteration,
  loadingModel,
  queuePosition,
  responseStartedAt,
  pendingApproval,
  pendingCheckin,
  onAllow,
  onDeny,
  onCheckinContinue,
  onCheckinAnswer,
  onCheckinStop,
}: AgentStreamProps) {
  if (!run) {
    return (
      <VStack className="flex-1 items-center justify-center px-8">
        <Text className="text-center text-muted-foreground">
          Start a new agent run — describe what you want done, and it'll work in an isolated sandbox.
        </Text>
      </VStack>
    );
  }

  return (
    <VStack className="flex-1">
      <RunHeader
        title={run.title}
        state={state}
        mode={mode}
        iteration={iteration}
        queuePosition={queuePosition}
      />
      <Box className="flex-1">
        <MessageList
          conversation={run}
          responseStartedAt={responseStartedAt}
          loadingModel={loadingModel}
          queuePosition={queuePosition}
        />
      </Box>
      {mode === 'planning' && <PlanningBanner />}
      {pendingApproval && (
        <PermissionBar
          tool={pendingApproval.tool}
          args={pendingApproval.args}
          deadline={pendingApproval.deadline}
          onAllow={onAllow}
          onDeny={onDeny}
        />
      )}
      {/* Never both: a run parked on an approval is not also parked on a
          check-in, and the approval is the more specific question. Both take
          layout space above the composer rather than covering the list — the
          transcript is what either decision is made from. */}
      {!pendingApproval && pendingCheckin && (
        <StepCheckInBanner
          {...pendingCheckin}
          onContinue={onCheckinContinue}
          onAnswer={onCheckinAnswer}
          onStop={onCheckinStop}
        />
      )}
    </VStack>
  );
}
