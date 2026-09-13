import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAppUpdates } from '@/hooks/useAppUpdates';
import { useServerConfig } from '@/hooks/useServerConfig';

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
 * There is nothing to choose here. Which updates an install follows is
 * decided when it is built — dev, beta and production are separate apps — so
 * this row reports and acts rather than offering a switch: what is running,
 * whether an update is waiting, and a button to take it.
 */
export function UpdatesRow() {
  const { supported, check, install, status, error, progress, version } = useAppUpdates();
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

      <Text testID="settings.updates.copy" size="2xs" className="text-muted-foreground">
        Updates arrive when a release is published. Restart to apply one.
      </Text>
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
  // Named only when it is not the ordinary one: a beta tester's report needs
  // to say so, while "production" on every production install is noise.
  if (version.channel && version.channel !== 'production') parts.push(`${version.channel} channel`);
  parts.push(`server ${serverVersion ?? '—'}`);
  return parts.join(' · ');
}
