import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { AgentMode } from '@/lib/types';

const MODES: { value: AgentMode; label: string }[] = [
  { value: 'planning', label: 'Planning' },
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
];

interface ModeSelectorProps {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
}

export function ModeSelector({ mode, onChange }: ModeSelectorProps) {
  return (
    <HStack space="xs" className="px-3 pt-2">
      {MODES.map((m) => (
        <Pressable
          key={m.value}
          testID={`agent.mode.${m.value}`}
          onPress={() => { onChange(m.value); }}
          className={`rounded-full px-2.5 py-1 ${mode === m.value ? 'bg-primary/15' : 'bg-muted'}`}
        >
          <Text size="2xs" className={mode === m.value ? 'text-primary' : 'text-muted-foreground'}>
            {m.label}
          </Text>
        </Pressable>
      ))}
    </HStack>
  );
}
