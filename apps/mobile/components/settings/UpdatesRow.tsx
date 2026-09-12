import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { useAppUpdates } from '@/hooks/useAppUpdates';
import { useServerConfig } from '@/hooks/useServerConfig';
import { UPDATE_CHANNELS, type UpdateChannel } from '@/lib/update-channel';

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  production: 'Stable',
  beta: 'Beta',
};

/**
 * Which updates this install follows, and what it is running.
 *
 * Renders nothing where the app cannot update itself at all — a browser (the
 * server serves the web app and it changes when the server does), Expo Go,
 * development on native — rather than showing a control that would throw on
 * use. The desktop app is the deliberate exception: it always shows the row,
 * because a desktop build that is not checking (a development launch, an
 * install from a package manager) is otherwise indistinguishable from one
 * that is up to date. That is most of the reason this reads through
 * useAppUpdates rather than expo-updates directly.
 *
 * Both channels are described, not just the one being switched on, in the
 * same shape AutoCompactToggle uses: the difference between them is a
 * trade-off about timing and risk that nobody can infer from the words
 * "stable" and "beta" alone.
 */
export function UpdatesRow() {
  const { supported, channel, setChannel, check, install, status, error, progress, version } = useAppUpdates();
  // Fetched here, by the only thing that renders it. Reading it in the hook
  // dragged a GET /v1/config into every session through the banner that
  // mounts in AppShell — on every platform, for a value it never shows.
  const { config } = useServerConfig();
  const serverVersion = config?.version ?? null;
  if (!supported) return null;

  const busy = status === 'checking' || status === 'downloading';
  // "Checks are off" is a fact, not a fault: a development build, or an
  // install from a package manager that owns the binary. It reads muted, and
  // the button that would do nothing is disabled rather than absent.
  const off = status === 'off';

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
          // Its own testID: a spec selecting `settings.updates.check` while an
          // update happened to be staged would reload the app instead.
          <Button testID="settings.updates.install" size="sm" onPress={install}>
            <ButtonText>Restart to update</ButtonText>
          </Button>
        ) : (
          <Button testID="settings.updates.check" variant="outline" size="sm" isDisabled={busy || off} onPress={check}>
            <ButtonText>Check now</ButtonText>
          </Button>
        )}
        {busy && <Spinner size="small" />}
        <Text
          testID="settings.updates.status"
          size="2xs"
          className={`flex-1 ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {describeStatus(status, error, progress)}
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
          body="The same updates, earlier — including ones still being tested, which can be rough. You can switch back at any time; you keep the version you have until a stable release replaces it."
        />
      </VStack>
    </VStack>
  );
}

function describeStatus(
  status: ReturnType<typeof useAppUpdates>['status'],
  error: string | null,
  progress: number | null,
): string {
  switch (status) {
    case 'off':
      return error ?? 'Not checking for updates.';
    case 'checking':
      return 'Checking…';
    case 'downloading':
      // The desktop downloads a whole installer and reports bytes; a JS
      // bundle over the air is done before a percentage would be readable.
      return progress === null ? 'Downloading…' : `Downloading… ${String(Math.round(progress * 100))}%`;
    case 'ready':
      return 'An update is ready. It applies when you restart.';
    case 'error':
      return error ?? 'The update check failed.';
    default:
      return 'Up to date.';
  }
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
