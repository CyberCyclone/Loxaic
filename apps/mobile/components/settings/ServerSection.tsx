import { useState } from 'react';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { useInstanceState } from '@/hooks/useInstanceState';
import { ServerSettingsModal } from './ServerSettingsModal';
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
  if (!state?.mode) return null;

  const title =
    state.mode === 'solo'
      ? 'Just this machine'
      : state.mode === 'host'
        ? `Hosting as "${state.host?.name ?? ''}"`
        : 'Connected to a host';
  const subtitle = state.mode === 'client' ? state.apiBaseUrl : (state.host?.advertiseUrl ?? state.apiBaseUrl);

  return (
    <>
      <VStack space="xs">
        <Text size="xs" className="text-muted-foreground">Server</Text>
        <Box className="rounded-md border border-border bg-card px-3 py-2.5">
          <HStack space="sm" className="items-center justify-between">
            <VStack className="flex-1">
              <Text size="sm" className="text-foreground">{title}</Text>
              {subtitle && (
                <Text size="2xs" className="text-muted-foreground">{subtitle}</Text>
              )}
            </VStack>
            <Button testID="settings.server.edit" variant="outline" size="sm" onPress={() => { setEditing(true); }}>
              <ButtonText>{state.mode === 'client' ? 'Change host' : 'Edit'}</ButtonText>
            </Button>
          </HStack>
        </Box>
      </VStack>
      <ServerSettingsModal open={editing} onClose={() => { setEditing(false); }} state={state} />
    </>
  );
}
