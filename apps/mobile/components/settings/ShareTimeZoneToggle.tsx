import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Outcome } from './Outcome';

/**
 * Whether each message tells the model the sender's time zone. The server
 * holds the choice and enforces it (streams/runs/local-time.ts), so an app
 * that sends the zone anyway cannot put it in a thread.
 */
export function ShareTimeZoneToggle({
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
      <HStack space="sm" className="items-center">
        <Switch testID="settings.shareTimeZone.toggle" value={value} onValueChange={onChange} isDisabled={disabled} />
        <Text size="sm" className="flex-1 text-foreground">
          Send my time zone with messages
        </Text>
      </HStack>
      <VStack space="xs" className="mt-1">
        <Outcome
          active={value}
          testID="settings.shareTimeZone.onCopy"
          label="On"
          body="Each message tells the model the date and time you sent it, in your time zone, so it can say “this morning” or “next Tuesday” and mean yours. The zone goes to the server and the model's provider, and the model can repeat it to others in a shared conversation."
        />
        <Outcome
          active={!value}
          testID="settings.shareTimeZone.offCopy"
          label="Off"
          body="Each message is dated in UTC instead, and your routines are too. The model knows when you sent it, but not your time zone."
        />
      </VStack>
    </VStack>
  );
}
