import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { PresetChips, type Chip } from '@/components/settings/PresetChips';
import { usePrefs } from '@/hooks/usePrefs';
import { useServerReachable } from '@/lib/connection';
import { locationPermissionStatus } from '@/lib/deviceLocation';
import type { LocationSharing } from '@loxaic/api-client';

const CHOICES: Chip<LocationSharing>[] = [
  { value: 'off', label: 'Off', key: 'off' },
  { value: 'ask', label: 'Ask each time', key: 'ask' },
  { value: 'always', label: 'Always allow', key: 'always' },
];

const HELP: Record<LocationSharing, string> = {
  off: 'The assistant is told location sharing is off, and asks you where you are when it needs to know.',
  ask: 'When the assistant asks for your location, you are asked first: Allow once, Always allow, or Don’t allow.',
  always:
    'Your device answers the assistant’s request without asking you. Anything the assistant reads, such as a web page, a file or a message, can lead it to ask, so your town can be shared without you seeing it happen.',
};

const OS_STATUS = {
  granted: 'This device lets Loxaic use its location.',
  denied: 'This device does not let Loxaic use its location. The assistant is told so; turn it on in the system settings to share.',
  undetermined: 'This device will ask whether Loxaic may use its location the first time you share it.',
  unsupported: 'This device or page cannot share a location (a browser shares one only with a page served over https).',
} as const;

/**
 * Location: whether the assistant may learn where you are, for questions like
 * the weather or local news (the `get_location` tool). The device sends its
 * approximate position, to about a kilometre, to the server, which names the
 * nearest town from its own list (GeoNames); the model is told only the town,
 * and the position goes nowhere else.
 */
export default function LocationScreen() {
  const shell = useShell();
  const { prefs, loading, busy, save } = usePrefs();
  const reachable = useServerReachable();
  const [osStatus, setOsStatus] = useState<keyof typeof OS_STATUS | null>(null);

  const refreshOsStatus = useCallback(() => {
    void locationPermissionStatus().then(setOsStatus);
  }, []);
  useEffect(() => {
    refreshOsStatus();
    // Coming back from the system settings: say what changed.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshOsStatus();
    });
    return () => { sub.remove(); };
  }, [refreshOsStatus]);

  const body = () => {
    if (loading) {
      return (
        <Box className="flex-1 items-center justify-center p-6">
          <Spinner />
        </Box>
      );
    }
    if (!prefs) {
      return (
        <Text testID="location.unavailable" size="sm" className="p-4 text-muted-foreground">
          These settings could not be loaded. Check the connection to the server.
        </Text>
      );
    }
    return (
      <VStack space="lg" className="p-4">
        <Text size="xs" className="text-muted-foreground">
          The assistant can ask which town you’re in, and your local time, for questions like today’s weather or the news
          where you are. It is told only the nearest town, never your position.
        </Text>
        {/* Hidden against a server that predates the setting. */}
        {prefs.locationSharing !== undefined && (
          <VStack space="sm">
            <Text size="sm" className="font-medium text-foreground">
              Share my location
            </Text>
            <PresetChips
              chips={CHOICES}
              value={prefs.locationSharing}
              onChoose={(v) => { save({ locationSharing: v }); }}
              disabled={busy || !reachable}
              testIDPrefix="location.sharing"
            />
            <Text testID="location.sharing.help" size="xs" className="text-muted-foreground">
              {HELP[prefs.locationSharing]}
            </Text>
          </VStack>
        )}
        {osStatus ? (
          <VStack space="xs" className="border-t border-border pt-4">
            <Text size="sm" className="font-medium text-foreground">
              This device
            </Text>
            <Text testID="location.osStatus" size="xs" className="text-muted-foreground">
              {OS_STATUS[osStatus]}
            </Text>
            {/* Works offline: it opens this device's own settings. */}
            {Platform.OS !== 'web' && osStatus === 'denied' ? (
              <Button
                testID="location.openSystemSettings"
                variant="outline"
                size="sm"
                className="self-start"
                onPress={() => { void Linking.openSettings(); }}
              >
                <ButtonText>Open system settings</ButtonText>
              </Button>
            ) : null}
          </VStack>
        ) : null}
        <Text testID="location.attribution" size="xs" className="border-t border-border pt-4 text-muted-foreground">
          Town names contain data from GeoNames (geonames.org), licensed under CC BY 4.0.
        </Text>
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Location" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="location.scroll" className="flex-1">
        {body()}
      </ScrollView>
    </VStack>
  );
}
