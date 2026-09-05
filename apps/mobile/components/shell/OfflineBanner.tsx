import { CloudOff, RefreshCw } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useConnection } from '@/lib/connection';

/**
 * Tells the user the server is unreachable, above whatever they were reading.
 *
 * Before this there was no indication at all: the socket's reconnect loop ran
 * silently forever while the UI carried on looking live, and a send during
 * that window was dropped without a word. Cached conversations still render
 * underneath — the point is that what they are looking at is a local copy,
 * not that the app is broken.
 *
 * Same shape as the sandbox-degraded banner on the agent screen, deliberately:
 * one visual language for "something is wrong but the app still works".
 */
export function OfflineBanner() {
  const connection = useConnection();
  if (connection === 'online') return null;

  const reconnecting = connection === 'reconnecting';
  return (
    <Box
      testID="shell.offlineBanner"
      className="flex-row items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2"
    >
      <Icon as={reconnecting ? RefreshCw : CloudOff} size="xs" className="text-destructive" />
      <Text size="xs" className="flex-1 text-destructive" numberOfLines={1}>
        {reconnecting
          ? 'Reconnecting to your server…'
          : "Can't reach your server. Showing your saved copy — you can read, but not send."}
      </Text>
    </Box>
  );
}
