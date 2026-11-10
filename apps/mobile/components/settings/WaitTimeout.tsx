import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { formatDuration, WAIT_PRESETS_MS } from '@/lib/waitSettings';
import { PresetChips, type Chip } from './PresetChips';

/**
 * A length of time with presets: how long a tool approval waits for a person,
 * or how much working time passes between progress reviews. `value` null is
 * "the server's default", which is named with its actual length so choosing it
 * is not a guess.
 */
export function WaitTimeout({
  label,
  help,
  value,
  serverDefaultMs,
  onChoose,
  disabled,
  testIDPrefix,
  presetsMs = WAIT_PRESETS_MS,
}: {
  label: string;
  help: string;
  value: number | null;
  serverDefaultMs: number | undefined;
  onChoose: (value: number | null) => void;
  disabled?: boolean;
  testIDPrefix: string;
  /** The choices beside "server default"; the approval wait's by default. */
  presetsMs?: readonly number[];
}) {
  const presets: number[] = [...presetsMs];
  // A value set some other way (the API, an older client) is shown as its own
  // chip, so the row never renders with nothing selected.
  if (value != null && !presets.includes(value)) presets.push(value);
  presets.sort((a, b) => a - b);

  const chips: Chip<number | null>[] = [
    {
      value: null,
      label: serverDefaultMs != null ? `Server default (${formatDuration(serverDefaultMs)})` : 'Server default',
      key: 'default',
    },
    ...presets.map((ms) => ({ value: ms, label: formatDuration(ms), key: String(ms) })),
  ];

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        {label}
      </Text>
      <PresetChips chips={chips} value={value} onChoose={onChoose} disabled={disabled} testIDPrefix={testIDPrefix} />
      <Text size="2xs" className="text-muted-foreground">
        {help}
      </Text>
    </VStack>
  );
}
