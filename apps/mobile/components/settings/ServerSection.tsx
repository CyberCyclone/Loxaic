import { useState } from 'react';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { useInstanceState } from '@/hooks/useInstanceState';
import { ServerSettingsModal } from './ServerSettingsModal';
import { TailnetStatusCard } from './TailnetStatusCard';
import { electronBridge } from '@/lib/endpoint';

/**
 * Desktop-only: shows this install's current mode and address, with an Edit
 * flow that reuses the same `setMode` path onboarding used to set it up in
 * the first place — so "change it later" needed no new write path, only a
 * form that pre-fills from the current state. Null off Electron (nothing to
 * show — every other platform reaches a host through the endpoint field
 * below) and before the first state fetch resolves.
 */
export function ServerSection() {
  const state = useInstanceState();
  const [editing, setEditing] = useState(false);

  if (!electronBridge()) return null;
  if (!state) return null;

  // `mode` is null while the stack is down — including right after a save
  // that failed to start it. That is exactly when this row must stay on
  // screen: unmounting here would take the edit dialog (and the error it was
  // about to show) with it, leaving a dead app with no explanation and no way
  // to change the setting that broke it. `storedMode` is what config.json
  // says, whether or not anything is running.
  const mode = state.mode ?? state.storedMode;
  if (!mode) return null;
  const down = state.mode === null;

  const title =
    mode === 'solo'
      ? 'Just this machine'
      : mode === 'host'
        ? `Hosting as "${state.host?.name ?? ''}"`
        : 'Connected to a host';
  // What this install is actually reachable at: for a host, whatever the
  // server was told to advertise — the tailnet address once that join lands.
  const subtitle =
    mode === 'client'
      ? (state.client?.hostUrl ?? state.apiBaseUrl)
      : (state.effectiveAdvertiseUrl ?? state.host?.advertiseUrl ?? state.apiBaseUrl);

  return (
    <>
      <VStack space="xs">
        <Text size="xs" className="text-muted-foreground">Server</Text>
        <Box className="rounded-md border border-border bg-card px-3 py-2.5">
          <HStack space="sm" className="items-center justify-between">
            <VStack className="flex-1">
              <Text size="sm" className="text-foreground">{title}</Text>
              {down ? (
                <Text testID="settings.server.down" size="2xs" className="text-destructive">
                  Not running{state.error ? `: ${state.error}` : ''}
                </Text>
              ) : subtitle ? (
                <Text size="2xs" className="text-muted-foreground">{subtitle}</Text>
              ) : null}
            </VStack>
            <Button testID="settings.server.edit" variant="outline" size="sm" onPress={() => { setEditing(true); }}>
              <ButtonText>{mode === 'client' ? 'Change host' : 'Edit'}</ButtonText>
            </Button>
          </HStack>
        </Box>
        <TailnetStatusCard testIDPrefix="settings.server.tailnet.status" />
      </VStack>
      <ServerSettingsModal open={editing} onClose={() => { setEditing(false); }} state={state} />
    </>
  );
}
