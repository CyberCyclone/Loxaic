import { useState } from 'react';
import { ArrowUpCircle } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { useAppUpdates } from '@/hooks/useAppUpdates';

/**
 * Tells the user an update is downloaded and waiting, above whatever they
 * were reading.
 *
 * The update is already on the device by the time this appears — the only
 * thing left is a restart, and that is the user's to choose. Restarting on
 * their behalf would take the screen away mid-sentence, which is why the
 * update layer never reloads by itself.
 *
 * Dismissal lasts for this session only: the update is still there, and it
 * will apply on the next launch anyway. Same visual language as the offline
 * banner, one row up from the content.
 */
export function UpdateReadyBanner() {
  const { status, install } = useAppUpdates();
  const [dismissed, setDismissed] = useState(false);

  if (status !== 'ready' || dismissed) return null;

  return (
    <Box
      testID="shell.updateBanner"
      className="flex-row items-center gap-2 border-b border-border bg-primary/10 px-3 py-2"
    >
      <Icon as={ArrowUpCircle} size="xs" className="text-primary" />
      <Text size="xs" className="flex-1 text-primary" numberOfLines={1}>
        An update is ready.
      </Text>
      <Pressable testID="shell.updateBanner.restart" onPress={install} className="rounded-sm px-2 py-0.5">
        <Text size="xs" className="font-medium text-primary">Restart now</Text>
      </Pressable>
      <Pressable
        testID="shell.updateBanner.dismiss"
        onPress={() => { setDismissed(true); }}
        className="rounded-sm px-2 py-0.5"
      >
        <Text size="xs" className="text-muted-foreground">Later</Text>
      </Pressable>
    </Box>
  );
}
