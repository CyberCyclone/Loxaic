import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { SandboxMode } from '@loxaic/api-client';

const MODES: { value: SandboxMode; label: string }[] = [
  { value: 'container', label: 'Container' },
  { value: 'host', label: 'Host' },
  { value: 'off', label: 'Off' },
];

interface ModePickerProps {
  mode: SandboxMode;
  disabled: boolean;
  onSelect: (mode: SandboxMode) => void;
}

export function ModePicker({ mode, disabled, onSelect }: ModePickerProps) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Mode
      </Text>
      <HStack space="xs">
        {MODES.map((m) => (
          <Pressable
            key={m.value}
            testID={`sandbox.mode.${m.value}`}
            disabled={disabled}
            onPress={() => { onSelect(m.value); }}
            className={`rounded-full px-3 py-1.5 ${
              mode === m.value ? 'bg-primary/15' : 'bg-muted'
            } ${disabled ? 'opacity-40' : ''}`}
          >
            <Text size="sm" className={mode === m.value ? 'text-primary' : 'text-muted-foreground'}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </HStack>
    </VStack>
  );
}
