import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { InferenceSettings } from '@loxaic/api-client';

/**
 * How many chats may use the model at once.
 *
 * The choice is deliberately framed as "follow the backend" versus a pinned
 * number, because the right answer is a fact about the model server rather
 * than a preference: llama.cpp's `--parallel` is exactly how many prompt
 * caches it keeps, and claiming more than it has makes every conversation slow
 * without producing an error anywhere. The resolved number is shown next to
 * the choice, since "Automatic" alone would leave an admin unable to tell
 * whether their `--parallel 4` was picked up.
 */
const CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'Automatic' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
  { value: 8, label: '8' },
];

interface RunQueueSettingsProps {
  settings: InferenceSettings;
  onChange: (maxConcurrentRuns: number | null) => void;
}

export function RunQueueSettings({ settings, onChange }: RunQueueSettingsProps) {
  const disabled = settings.envOverrides.maxConcurrentRuns;
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Concurrent runs
      </Text>
      <HStack space="xs">
        {CHOICES.map((choice) => {
          const selected = settings.maxConcurrentRuns === choice.value;
          return (
            <Pressable
              key={choice.label}
              testID={`inference.concurrency.${choice.value === null ? 'auto' : String(choice.value)}`}
              disabled={disabled}
              onPress={() => { onChange(choice.value); }}
              className={`rounded-full px-3 py-1.5 ${selected ? 'bg-primary/15' : 'bg-muted'} ${
                disabled ? 'opacity-40' : ''
              }`}
            >
              <Text size="sm" className={selected ? 'text-primary' : 'text-muted-foreground'}>
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </HStack>
      <Text testID="inference.concurrency.explainer" size="xs" className="text-muted-foreground">
        {settings.maxConcurrentRuns === null
          ? `Following the model server: ${String(settings.effectiveMaxConcurrentRuns)} at a time.`
          : `Pinned to ${String(settings.maxConcurrentRuns)} at a time.`}{' '}
        Chats beyond this wait in a queue and are told their place. More than the server can
        actually hold makes every conversation slower, because each one evicts the last one&apos;s
        cached prompt.
      </Text>
      {disabled && (
        <Text size="xs" className="text-muted-foreground">
          Set by the INFERENCE_MAX_CONCURRENT_RUNS environment variable.
        </Text>
      )}
    </VStack>
  );
}
