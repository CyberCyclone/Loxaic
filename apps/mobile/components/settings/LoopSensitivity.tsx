import type { LoopSensitivity as Sensitivity } from '@loxaic/api-client';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { PresetChips } from './PresetChips';

const LABELS: Record<Sensitivity, string> = { normal: 'Normal', relaxed: 'Relaxed', off: 'Off' };

const COPY: Record<Sensitivity, string> = {
  normal:
    'Asks as soon as the agent makes exactly the same calls three times running, or goes round the same two or three steps twice.',
  relaxed:
    'Waits for five identical steps in a row, or the same short cycle three times — for work that legitimately retries, like polling a build.',
  off: 'Never asks early. The agent still checks in at the step count above; a run that really is stuck just takes longer to notice.',
};

/**
 * How readily the agent notices itself repeating. Only ever about identical
 * calls — waiting on a slow model is never counted, however long it takes.
 */
export function LoopSensitivity({
  value,
  onChoose,
  disabled,
}: {
  value: Sensitivity;
  onChoose: (value: Sensitivity) => void;
  disabled?: boolean;
}) {
  const order: Sensitivity[] = ['normal', 'relaxed', 'off'];
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Noticing repetition
      </Text>
      <PresetChips
        chips={order.map((s) => ({ value: s, label: LABELS[s], key: s }))}
        value={value}
        onChoose={onChoose}
        disabled={disabled}
        testIDPrefix="settings.loopSensitivity"
      />
      <Text testID="settings.loopSensitivity.copy" size="2xs" className="text-muted-foreground">
        {COPY[value]} Time spent waiting for the model never counts as repeating.
      </Text>
    </VStack>
  );
}
