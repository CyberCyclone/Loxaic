import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Badge, BadgeText } from '@/components/ui/badge';
import type { AgentMode } from '@/lib/types';
import type { RunState } from '@/hooks/useAgentSession';

const STATE_LABEL: Record<RunState, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  // Not "Awaiting answer": the run is asking a question, and the person it is
  // asking is the one reading this.
  awaiting_checkin: 'Waiting for you',
  stopping: 'Stopping…',
  done: 'Done',
  error: 'Error',
};

const STATE_DOT: Record<RunState, string> = {
  // Amber, like awaiting_approval: both mean "this run exists but is not
  // doing anything", which is the distinction a status dot is for.
  queued: 'bg-warning',
  running: 'bg-primary',
  awaiting_approval: 'bg-warning',
  awaiting_checkin: 'bg-warning',
  // Amber too: asked to stop, but not stopped — the run is still winding up.
  stopping: 'bg-warning',
  done: 'bg-success',
  error: 'bg-destructive',
};

interface RunHeaderProps {
  title: string;
  state: RunState;
  mode: AgentMode;
  iteration: { n: number; max: number } | null;
  /** Place in the inference queue, when this run is waiting for one. */
  queuePosition?: number | null;
}

export function RunHeader({ title, state, mode, iteration, queuePosition }: RunHeaderProps) {
  return (
    <HStack space="sm" className="items-center border-b border-border px-4 py-2.5">
      {/* Same pair as MainHeader: the title may shrink and truncate, the two
          chips beside it may not give way. `flex-1` alone let a long run title
          squeeze them instead. */}
      <Text className="min-w-0 flex-1 truncate font-medium text-foreground" numberOfLines={1}>
        {title}
      </Text>
      <HStack space="xs" className="shrink-0 items-center rounded-full bg-muted px-2 py-1">
        <Box className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} />
        <Text testID="agent.run.status" size="xs" className="text-muted-foreground">
          {STATE_LABEL[state]}
          {/* Shown while parked too: the step count is what the check-in is
              *about*, so hiding it at exactly that moment is backwards. */}
          {(state === 'running' || state === 'awaiting_checkin') && iteration
            ? ` · ${String(iteration.n)}/${String(iteration.max)}`
            : ''}
          {state === 'queued' && queuePosition ? ` · #${String(queuePosition)}` : ''}
        </Text>
      </HStack>
      <Badge variant="outline" className="shrink-0 border-border">
        <BadgeText className="text-2xs normal-case">{mode}</BadgeText>
      </Badge>
    </HStack>
  );
}
