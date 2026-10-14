import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { ModeSwitch } from './ModeSwitch';
import type { AgentMode } from '@/lib/types';
import type { RunState } from '@/hooks/useAgentSession';
import { TRUNCATE_TEXT } from '@/lib/truncate';
// The words and colours live in lib so a thread-list row (#282) cannot
// disagree with this header about what a state is called.
import { STATE_DOT, STATE_LABEL } from '@/lib/runStateCopy';

interface RunHeaderProps {
  title: string;
  state: RunState;
  mode: AgentMode;
  /** Choosing a mode from the header (#266) — the row above the composer used
   * to be the only control, and it is gone now. */
  onModeChange: (mode: AgentMode) => void;
  iteration: { n: number; max: number } | null;
  /** Place in the inference queue, when this run is waiting for one. */
  queuePosition?: number | null;
}

export function RunHeader({ title, state, mode, onModeChange, iteration, queuePosition }: RunHeaderProps) {
  return (
    <HStack space="sm" className="items-center border-b border-border px-4 py-2.5">
      {/* Same pair as MainHeader: the title may shrink and truncate, the two
          chips beside it may not give way. `flex-1` alone let a long run title
          squeeze them instead. */}
      <Text
        className="min-w-0 flex-1 font-medium text-foreground"
        numberOfLines={1}
        style={TRUNCATE_TEXT}
      >
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
      {/* The read-only mode Badge is the mode control now (#266): the mode is
          changed from where it was already being read. A segmented switch,
          so choosing is one tap and every option is on screen. */}
      <ModeSwitch mode={mode} onChange={onModeChange} />
    </HStack>
  );
}
