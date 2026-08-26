import { Terminal } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Badge, BadgeText } from '@/components/ui/badge';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { AgentMode } from '@/lib/types';
import type { RunState } from '@/hooks/useAgentSession';

const STATE_LABEL: Record<RunState, string> = {
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
  error: 'Error',
};

const STATE_DOT: Record<RunState, string> = {
  running: 'bg-primary',
  awaiting_approval: 'bg-warning',
  done: 'bg-success',
  error: 'bg-destructive',
};

interface RunHeaderProps {
  title: string;
  state: RunState;
  mode: AgentMode;
  iteration: { n: number; max: number } | null;
  /** Dev mode only — opens the Raw I/O panel. */
  onOpenDebug?: () => void;
  debugActive?: boolean;
}

export function RunHeader({ title, state, mode, iteration, onOpenDebug, debugActive }: RunHeaderProps) {
  return (
    <HStack space="sm" className="items-center border-b border-border px-4 py-2.5">
      <Text className="flex-1 font-medium text-foreground" numberOfLines={1}>
        {title}
      </Text>
      {onOpenDebug && (
        <Pressable
          onPress={onOpenDebug}
          className={`rounded-sm p-1.5 web:hover:bg-muted/50 ${debugActive ? 'bg-primary/15' : ''}`}
        >
          <Icon as={Terminal} size="sm" className={debugActive ? 'text-primary' : 'text-muted-foreground'} />
        </Pressable>
      )}
      <HStack space="xs" className="items-center rounded-full bg-muted px-2 py-1">
        <Box className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} />
        <Text size="xs" className="text-muted-foreground">
          {STATE_LABEL[state]}
          {state === 'running' && iteration ? ` · ${iteration.n}/${iteration.max}` : ''}
        </Text>
      </HStack>
      <Badge variant="outline" className="border-border">
        <BadgeText className="text-2xs normal-case">{mode}</BadgeText>
      </Badge>
    </HStack>
  );
}
