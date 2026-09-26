import { CloudOff, RefreshCw } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { disconnectedCopy, showsDisconnected, useConnection } from '@/lib/connection';
import { retryNow } from '@/lib/connectionMonitor';

/**
 * Tells the user the server is unreachable — once, for the whole app.
 *
 * It used to be rendered by three screens (chat, agent, a routine's chat), so
 * every other screen said nothing while its buttons failed, and a screen's
 * banner went stale when its socket unmounted. It lives in the shell now, above
 * the sidebar and every screen, and reads the one state the connection monitor
 * decides (lib/connectionMonitor.ts). Silent during a grace period: an
 * ordinary app switch replaces the sockets, and a banner flashing on every one
 * of them against a healthy server would teach people to ignore it.
 *
 * Dialogs and sheets cover it, which is why they carry a `DisconnectedNote`.
 * Same shape as the sandbox-degraded banner on the agent screen, deliberately:
 * one visual language for "something is wrong but the app still works".
 */
export function ConnectionBanner() {
  const connection = useConnection();
  if (!showsDisconnected(connection)) return null;

  const offline = connection === 'offline';
  return (
    <Box
      testID="shell.offlineBanner"
      className="flex-row items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2"
    >
      <Icon as={offline ? CloudOff : RefreshCw} size="xs" className="text-destructive" />
      <Text size="xs" className="flex-1 text-destructive">
        {disconnectedCopy(connection).banner}
      </Text>
      {/* Only once it has given up waiting: while reconnecting it is already
          trying, as fast as it sensibly can. */}
      {offline && (
        <Button testID="shell.offlineRetry" size="sm" variant="outline" onPress={retryNow}>
          <ButtonText>Retry</ButtonText>
        </Button>
      )}
    </Box>
  );
}
