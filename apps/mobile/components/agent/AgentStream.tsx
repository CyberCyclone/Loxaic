import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Box } from '@/components/ui/box';
import { MessageList } from '@/components/chat/MessageList';
import { RunHeader } from './RunHeader';
import { PlanningBanner } from './PlanningBanner';
import { PermissionBar } from './PermissionBar';
import type { Conversation, AgentMode } from '@/lib/types';
import type { RunState, PendingApproval } from '@/hooks/useAgentSession';

interface AgentStreamProps {
  run: Conversation | null;
  state: RunState;
  mode: AgentMode;
  iteration: { n: number; max: number } | null;
  pendingApproval: PendingApproval | null;
  onAllow: () => void;
  onDeny: () => void;
}

export function AgentStream({ run, state, mode, iteration, pendingApproval, onAllow, onDeny }: AgentStreamProps) {
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
      <RunHeader title={run.title} state={state} mode={mode} iteration={iteration} />
      <Box className="flex-1">
        <MessageList conversation={run} />
      </Box>
      {mode === 'planning' && <PlanningBanner />}
      {pendingApproval && (
        <PermissionBar tool={pendingApproval.tool} args={pendingApproval.args} onAllow={onAllow} onDeny={onDeny} />
      )}
    </VStack>
  );
}
