import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { AgentMode } from '@/lib/types';
import { useServerReachable } from '@/lib/connection';

const MODES: { value: AgentMode; label: string }[] = [
  { value: 'planning', label: 'Planning' },
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
];

interface ModeSwitchProps {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
}

/**
 * The run's permission mode, as a three-segment switch — the control that
 * used to sit above the composer, moved into the run header (#266).
 *
 * The issue asked for the mode to live where it is already *read*: the bar
 * at the top right. The first cut of this was a popover on the header badge
 * — one tap to open, one to choose — and it was wrong for two reasons.
 * Two taps to change a mode is worse than one, and a mode set is not a
 * rare action to optimise chrome for. And the three option rows are what
 * the whole e2e vocabulary addresses (`agent.mode.<mode>`: tap-to-choose,
 * `aria-selected` after Accept runs the work, the disabled sweep while the
 * server is unreachable, `waitForVisible` as the agent screen's mount
 * anchor); behind an expander every one of those stops existing until
 * opened. A segmented switch keeps the badge's job — the active segment
 * *is* the mode readout — at one tap and zero new states.
 *
 * The chips' rules travel unchanged: each segment is a Pressable that
 * disables with the socket (so the offline sweep still finds
 * `agent.mode.<mode>` exactly where it always did), and `useAgentSession`
 * ignores local mode updates unless the server echoes them — the guard is
 * why disabling matters, not merely nice.
 */
export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  const reachable = useServerReachable();
  return (
    <HStack
      aria-label="Permission mode"
      className="shrink-0 flex-row items-center overflow-hidden rounded-full border border-border"
    >
      {MODES.map((m) => {
        const active = mode === m.value;
        return (
          <Pressable
            key={m.value}
            testID={`agent.mode.${m.value}`}
            aria-selected={active}
            disabled={!reachable}
            onPress={() => {
              onChange(m.value);
            }}
            className={`px-2 py-1 ${active ? 'bg-primary/15' : reachable ? 'hover:bg-muted/50' : 'opacity-50'}`}
          >
            <Text size="2xs" className={active ? 'font-medium text-primary' : 'text-muted-foreground'}>
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </HStack>
  );
}
