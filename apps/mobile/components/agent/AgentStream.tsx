import type { PromptStats } from '@loxaic/api-client';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Box } from '@/components/ui/box';
import type { StageCard } from '@/lib/stageCard';
import { MessageList, type MessageHistory } from '@/components/chat/MessageList';
import { RunHeader } from './RunHeader';
import { ModeSwitch } from './ModeSwitch';
import { PlanningBanner } from './PlanningBanner';
import { PermissionBar } from './PermissionBar';
import { StepCheckInBanner } from '@/components/chat/StepCheckInBanner';
import type { Conversation, AgentMode } from '@/lib/types';
import type { RunState, PendingApproval, PendingCheckin } from '@/hooks/useAgentSession';

interface AgentStreamProps {
  run: Conversation | null;
  state: RunState;
  mode: AgentMode;
  /** Choosing the mode (#266) — the control moved from the composer's chip
   * row into the header (and this screen's empty state). */
  onModeChange: (mode: AgentMode) => void;
  iteration: { n: number; max: number } | null;
  loadingModel?: boolean;
  promptStats?: PromptStats | null;
  queuePosition?: number | null;
  responseStartedAt?: number | null;
  pendingApproval: PendingApproval | null;
  /** Set when the approval shown is a sub-agent's rather than the run's own:
   * its description, so the bar says who is asking. */
  approvalSource?: string;
  pendingCheckin: PendingCheckin | null;
  /** Scroll-back through older history — see MessageList. */
  history?: MessageHistory | null;
  /** The latest step of a context-stage switch in this run. */
  stageCard?: StageCard | null;
  onAllow: () => void;
  /** "Allow always" on the bar (#266) — see PermissionBar. */
  onAllowAlways: () => void;
  onDeny: () => void;
  onCheckinContinue: () => void;
  onCheckinAnswer: () => void;
  onCheckinStop: () => void;
}

export function AgentStream({
  run,
  state,
  mode,
  onModeChange,
  iteration,
  loadingModel,
  promptStats,
  queuePosition,
  responseStartedAt,
  pendingApproval,
  approvalSource,
  pendingCheckin,
  history,
  stageCard,
  onAllow,
  onAllowAlways,
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
        {/* The mode of the *first* message has to be choosable before any run
            exists, and RunHeader — where the control lives now — only renders
            for one. Without this the chip row's removal would leave no way to
            start a run in Planning or Auto at all. */}
        <Box className="mt-4">
          <ModeSwitch mode={mode} onChange={onModeChange} />
        </Box>
      </VStack>
    );
  }

  return (
    <VStack className="flex-1">
      <RunHeader
        title={run.title}
        state={state}
        mode={mode}
        onModeChange={onModeChange}
        iteration={iteration}
        queuePosition={queuePosition}
      />
      <Box className="flex-1">
        <MessageList
          conversation={run}
          responseStartedAt={responseStartedAt}
          loadingModel={loadingModel}
          promptStats={promptStats}
          queuePosition={queuePosition}
          history={history}
          stageCard={stageCard}
        />
      </Box>
      {mode === 'planning' && <PlanningBanner />}
      {pendingApproval && (
        <PermissionBar
          tool={pendingApproval.tool}
          args={pendingApproval.args}
          deadline={pendingApproval.deadline}
          source={approvalSource}
          mode={pendingApproval.mode}
          granterUserId={pendingApproval.granterUserId}
          onAllow={onAllow}
          onAllowAlways={onAllowAlways}
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
