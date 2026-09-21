import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { PresetChips } from './PresetChips';

const CHOICES = [0, 1, 2, 3] as const;

/**
 * What an unanswered check-in does: keep going on its own this many times in
 * a row, then wrap up. The cost is stated in steps, because that is what an
 * auto-continue actually grants — another full window of tool calls with
 * nobody watching.
 */
export function UnattendedCheckins({
  value,
  stepsPerWindow,
  onChoose,
  disabled,
}: {
  value: number;
  stepsPerWindow: number | undefined;
  onChoose: (value: number) => void;
  disabled?: boolean;
}) {
  const steps = stepsPerWindow != null ? `${String(stepsPerWindow)} more steps` : 'another full window of steps';
  const describe =
    value === 0
      ? 'An unanswered check-in wraps up straight away with what the agent has so far.'
      : `An unanswered check-in keeps going on its own, up to ${String(value)} ${value === 1 ? 'time' : 'times'} in a row — each one is ${steps} with nobody watching. The next unanswered one wraps up with what it has. Answering any check-in yourself starts the count again.`;

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        When nobody answers a check-in
      </Text>
      <PresetChips
        chips={CHOICES.map((n) => ({ value: n, label: n === 0 ? 'Wrap up' : `Keep going ${String(n)}×`, key: String(n) }))}
        value={value}
        onChoose={onChoose}
        disabled={disabled}
        testIDPrefix="settings.autoContinues"
      />
      <Text testID="settings.autoContinues.copy" size="2xs" className="text-muted-foreground">
        {describe}
      </Text>
    </VStack>
  );
}
