import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';

export interface Chip<T> {
  value: T;
  label: string;
  /** The testID qualifier: `${testIDPrefix}.${key}`. */
  key: string;
}

/**
 * A row of mutually exclusive choices, the shape every preset-driven setting
 * here uses. Presets rather than number fields: the exact value almost never
 * matters, and a free-text box invites a number the API rejects.
 */
export function PresetChips<T>({
  chips,
  value,
  onChoose,
  disabled,
  testIDPrefix,
}: {
  chips: Chip<T>[];
  value: T;
  onChoose: (value: T) => void;
  disabled?: boolean;
  testIDPrefix: string;
}) {
  return (
    <HStack space="xs" className="flex-wrap">
      {chips.map((chip) => {
        const selected = chip.value === value;
        return (
          <Pressable
            key={chip.key}
            testID={`${testIDPrefix}.${chip.key}`}
            disabled={disabled}
            onPress={() => { onChoose(chip.value); }}
            className={`mb-1 rounded-full px-3 py-1.5 ${selected ? 'bg-primary/15' : 'bg-muted'}`}
          >
            <Text size="sm" className={selected ? 'text-primary' : 'text-muted-foreground'}>
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </HStack>
  );
}
