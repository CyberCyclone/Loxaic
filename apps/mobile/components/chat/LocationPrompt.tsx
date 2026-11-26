import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { useServerReachable } from '@/lib/connection';
import type { LocationAction, LocationChoice, PendingDeviceRequest } from '@/lib/deviceRequest';

/**
 * The run asking for the person's location (`get_location`), above the
 * composer where an approval would be. To the run's sender, "Share your
 * location?" with Don't allow / Allow once / Always allow; to anyone else
 * following the run, that it waits on the sender. Keyed by the request
 * (`deviceRequestKey`), so a new one remounts it.
 *
 * "Always allow" also turns the setting to Always (Settings → Location), so
 * later requests are answered without asking.
 */
export function LocationPrompt({
  pending,
  action,
  onAnswer,
}: {
  pending: PendingDeviceRequest;
  action: LocationAction;
  onAnswer: (choice: LocationChoice) => Promise<void>;
}) {
  const reachable = useServerReachable();
  const [busy, setBusy] = useState(false);
  // As the permission bar: on a phone the keyboard would cover the buttons.
  useEffect(() => {
    if (Platform.OS !== 'web' && action === 'prompt') Keyboard.dismiss();
  }, [action]);

  if (action === 'waitingForOther') {
    return (
      <VStack className="border-t border-border bg-muted/30 px-4 py-2">
        <Text testID="chat.location.waiting" size="sm" className="text-muted-foreground">
          Waiting for the person who sent this to share their location.
        </Text>
      </VStack>
    );
  }
  if (action !== 'prompt') return null;

  const choose = (choice: LocationChoice) => () => {
    setBusy(true);
    void onAnswer(choice).finally(() => { setBusy(false); });
  };
  const disabled = !reachable || busy;
  return (
    <VStack testID="chat.location.bar" space="xs" className="border-t border-warning/30 bg-warning/10 px-4 py-3">
      <Text testID="chat.location.title" className="font-semibold text-foreground">
        Share your location?
      </Text>
      <Text size="sm" className="text-muted-foreground">
        The assistant asked which town you’re in. It is told the nearest town and your local time, not your position.
      </Text>
      {pending.reason ? (
        <Text testID="chat.location.reason" size="sm" className="text-foreground">
          “{pending.reason}”
        </Text>
      ) : null}
      <DeadlineCountdown deadline={pending.deadline} testID="chat.location.countdown" />
      {busy ? (
        <Text testID="chat.location.status" size="sm" className="text-muted-foreground">
          Getting your location…
        </Text>
      ) : null}
      <DisconnectedNote testID="chat.location.disconnected" what="answer" />
      <HStack space="sm" className="flex-wrap items-center justify-end">
        <Button testID="chat.location.deny" variant="outline" size="sm" onPress={choose('deny')} isDisabled={disabled}>
          <ButtonText>Don't allow</ButtonText>
        </Button>
        <Button testID="chat.location.allowAlways" variant="outline" size="sm" onPress={choose('always')} isDisabled={disabled}>
          <ButtonText>Always allow</ButtonText>
        </Button>
        <Button testID="chat.location.allowOnce" size="sm" onPress={choose('once')} isDisabled={disabled}>
          <ButtonText>Allow once</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
