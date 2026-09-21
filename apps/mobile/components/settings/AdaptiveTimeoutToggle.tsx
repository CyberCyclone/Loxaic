import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Outcome } from './AutoCompactToggle';

/**
 * Whether a wait stretches to fit a slow backend. Both outcomes are spelled
 * out, as with auto-compaction: the trade is between being decided for on a
 * slow machine and a run sitting parked longer than the number above says.
 */
export function AdaptiveTimeoutToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Slow models
      </Text>
      <HStack space="sm" className="items-center">
        <Switch testID="settings.adaptiveTimeout.toggle" value={value} onValueChange={onChange} isDisabled={disabled} />
        <Text size="sm" className="flex-1 text-foreground">
          Wait longer when the model is slow
        </Text>
      </HStack>
      <VStack space="xs" className="mt-1">
        <Outcome
          active={value}
          testID="settings.adaptiveTimeout.onCopy"
          label="On"
          body="If one step of a run has taken longer than the wait above, the wait becomes twice that step instead. On a machine where a single step can take twenty minutes, you are never given less time to answer than the model takes to think."
        />
        <Outcome
          active={!value}
          testID="settings.adaptiveTimeout.offCopy"
          label="Off"
          body="The waits above are exact, however slow the model is. On a slow machine a check-in can be decided for you while the model is still working through the step before it."
        />
      </VStack>
    </VStack>
  );
}
