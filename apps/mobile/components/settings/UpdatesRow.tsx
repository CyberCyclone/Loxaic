import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { useAppUpdates } from '@/hooks/useAppUpdates';
import { UPDATE_CHANNELS, type UpdateChannel } from '@/lib/update-channel';

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  production: 'Stable',
  beta: 'Beta',
};

/**
 * Which updates this install follows, and what it is running.
 *
 * Renders nothing where the app cannot update itself — web (the server serves
 * it), Expo Go, development — rather than showing a control that would throw
 * on use. That is most of the reason this reads through useAppUpdates rather
 * than expo-updates directly.
 *
 * Both channels are described, not just the one being switched on, in the
 * same shape AutoCompactToggle uses: the difference between them is a
 * trade-off about timing and risk that nobody can infer from the words
 * "stable" and "beta" alone.
 */
export function UpdatesRow() {
  const { supported, channel, setChannel, check, install, status, error, version, serverVersion } = useAppUpdates();
  if (!supported) return null;

  const busy = status === 'checking' || status === 'downloading';

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">Updates</Text>

      <HStack space="xs">
        {UPDATE_CHANNELS.map((c) => (
          <Pressable
            key={c}
            testID={`settings.updates.channel.${c}`}
            onPress={() => { setChannel(c); }}
            className={`rounded-full px-3 py-1.5 ${channel === c ? 'bg-primary/15' : 'bg-muted'}`}
          >
            <Text size="sm" className={channel === c ? 'text-primary' : 'text-muted-foreground'}>
              {CHANNEL_LABEL[c]}
            </Text>
          </Pressable>
        ))}
      </HStack>

      <HStack space="sm" className="items-center">
        {status === 'ready' ? (
          <Button testID="settings.updates.check" size="sm" onPress={install}>
            <ButtonText>Restart to update</ButtonText>
          </Button>
        ) : (
          <Button testID="settings.updates.check" variant="outline" size="sm" isDisabled={busy} onPress={check}>
            <ButtonText>Check now</ButtonText>
          </Button>
        )}
        {busy && <Spinner size="small" />}
        <Text
          testID="settings.updates.status"
          size="2xs"
          className={`flex-1 ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {status === 'checking'
            ? 'Checking…'
            : status === 'downloading'
              ? 'Downloading…'
              : status === 'ready'
                ? 'An update is ready. It applies when you restart.'
                : status === 'error'
                  ? error
                  : 'Up to date.'}
        </Text>
      </HStack>

      <Text testID="settings.updates.version" size="2xs" className="text-muted-foreground">
        {describeVersion(version, serverVersion)}
      </Text>

      <VStack space="xs" className="mt-1">
        <Outcome
          active={channel === 'production'}
          testID="settings.updates.stableCopy"
          label="Stable"
          body="Updates arrive when a release is published. This is what everyone else is running, and what has had the most use before it reaches you."
        />
        <Outcome
          active={channel === 'beta'}
          testID="settings.updates.betaCopy"
          label="Beta"
          body="The same updates, earlier — including ones still being tested, which can be rough. You can switch back at any time; you keep the version you have until a stable release is newer than it, so switching back is never a downgrade."
        />
      </VStack>
    </VStack>
  );
}

/** One line naming exactly what is running, for a bug report to quote. The
 * binary's version is included because an update changes the JS and not the
 * native code, so the two genuinely differ. */
function describeVersion(
  version: ReturnType<typeof useAppUpdates>['version'],
  serverVersion: string | null,
): string {
  if (!version) return '';
  const parts: string[] = [];
  parts.push(`App ${version.appVersion ?? '—'}`);
  if (version.updateId) parts.push(`update ${version.updateId}`);
  else if (version.isEmbedded) parts.push('as shipped');
  if (version.nativeVersion && version.nativeVersion !== version.appVersion) {
    parts.push(`binary ${version.nativeVersion}`);
  }
  parts.push(`server ${serverVersion ?? '—'}`);
  return parts.join(' · ');
}

/** The branch in force reads normally; the other stays visible but dimmed,
 * so the consequence of switching is on screen before it is switched. */
function Outcome({
  active,
  label,
  body,
  testID,
}: {
  active: boolean;
  label: string;
  body: string;
  testID: string;
}) {
  return (
    <Box
      className={`rounded-md border px-2.5 py-2 ${
        active ? 'border-border bg-card' : 'border-transparent bg-muted/30'
      }`}
    >
      <Text size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
        <Text size="2xs" className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>
          {label}
          {active ? ' (current)' : ''}:{' '}
        </Text>
        <Text testID={testID} size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
          {body}
        </Text>
      </Text>
    </Box>
  );
}
