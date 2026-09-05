import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Input, InputField } from '@/components/ui/input';
import type { EngineProbe, SandboxEngine } from '@loxaic/api-client';

const ENGINES: { value: SandboxEngine; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'docker', label: 'Docker' },
  { value: 'podman', label: 'Podman' },
  { value: 'custom', label: 'Custom' },
];

function statusFor(id: 'docker' | 'podman', engines: EngineProbe[]): string {
  const probe = engines.find((e) => e.id === id);
  if (!probe) return '';
  if (!probe.available) return 'not detected';
  if (probe.detectedAs && probe.detectedAs !== id) return `detected as ${probe.detectedAs}`;
  return 'available';
}

interface EnginePickerProps {
  engine: SandboxEngine;
  customSocket: string;
  engines: EngineProbe[];
  disabled: boolean;
  onSelect: (engine: SandboxEngine) => void;
  onCustomSocketChange: (socket: string) => void;
  onCustomSocketSubmit: () => void;
}

/** Docker and Podman render disabled — not just visually dimmed but
 * unpressable — when probeEngines() didn't find them, per the ask: present
 * both as real choices and grey out whichever isn't installed. */
export function EnginePicker({
  engine,
  customSocket,
  engines,
  disabled,
  onSelect,
  onCustomSocketChange,
  onCustomSocketSubmit,
}: EnginePickerProps) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Container engine
      </Text>
      <HStack space="xs" className="flex-wrap">
        {ENGINES.map((e) => {
          const probe = e.value === 'docker' || e.value === 'podman' ? engines.find((p) => p.id === e.value) : null;
          const unavailable = probe ? !probe.available : false;
          return (
            <Pressable
              key={e.value}
              testID={`sandbox.engine.${e.value}`}
              disabled={disabled || unavailable}
              onPress={() => { onSelect(e.value); }}
              className={`rounded-full px-3 py-1.5 ${engine === e.value ? 'bg-primary/15' : 'bg-muted'} ${
                disabled || unavailable ? 'opacity-40' : ''
              }`}
            >
              <Text size="sm" className={engine === e.value ? 'text-primary' : 'text-muted-foreground'}>
                {e.label}
              </Text>
            </Pressable>
          );
        })}
      </HStack>
      <HStack space="md">
        {(['docker', 'podman'] as const).map((id) => (
          <Text key={id} size="2xs" className="text-muted-foreground">
            {id}: {statusFor(id, engines) || '…'}
          </Text>
        ))}
      </HStack>
      {engine === 'custom' && (
        <VStack space="xs" className="mt-1">
          <Text size="xs" className="text-muted-foreground">
            Socket path
          </Text>
          <Input className="border-border bg-card" isDisabled={disabled}>
            <InputField
              testID="sandbox.engine.customSocket"
              placeholder="/run/user/1000/podman/podman.sock"
              autoCapitalize="none"
              value={customSocket}
              onChangeText={onCustomSocketChange}
              onSubmitEditing={onCustomSocketSubmit}
              onBlur={onCustomSocketSubmit}
            />
          </Input>
          <Text size="2xs" className="text-muted-foreground">
            For Colima, OrbStack, or a remote engine.
          </Text>
        </VStack>
      )}
    </VStack>
  );
}
