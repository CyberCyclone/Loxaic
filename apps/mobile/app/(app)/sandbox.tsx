import { useState } from 'react';
import { ScrollView } from 'react-native';
import { VStack } from '@/components/ui/vstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { SandboxStatusCard } from '@/components/sandbox/SandboxStatusCard';
import { ModePicker } from '@/components/sandbox/ModePicker';
import { EnginePicker } from '@/components/sandbox/EnginePicker';
import { NetworkToggle } from '@/components/sandbox/NetworkToggle';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSandboxSettings } from '@/hooks/useSandboxSettings';
import { useSession } from '@/lib/session';
import type { SandboxEngine, SandboxMode } from '@shannon/api-client';

type PendingWarning = { kind: 'host' } | { kind: 'network' } | null;

export default function SandboxScreen() {
  const shell = useShell();
  const { token, isAdmin } = useSession();
  const { config, loading: configLoading, refresh: refreshConfig } = useServerConfig();
  const { settings, loading: settingsLoading, update } = useSandboxSettings(isAdmin ? token : null);
  const [pendingWarning, setPendingWarning] = useState<PendingWarning>(null);
  const [customSocketDraft, setCustomSocketDraft] = useState<string | null>(null);

  const applyAndRefresh = async (patch: Parameters<typeof update>[0]) => {
    await update(patch).catch(() => undefined);
    await refreshConfig();
  };

  const handleModeSelect = (mode: SandboxMode) => {
    if (mode === 'host') {
      setPendingWarning({ kind: 'host' });
      return;
    }
    void applyAndRefresh({ mode });
  };

  const handleEngineSelect = (engine: SandboxEngine) => {
    if (engine === 'custom') {
      setCustomSocketDraft(settings?.customSocket ?? '');
      return;
    }
    setCustomSocketDraft(null);
    void applyAndRefresh({ engine });
  };

  const handleCustomSocketSubmit = () => {
    if (customSocketDraft === null || customSocketDraft === settings?.customSocket) return;
    void applyAndRefresh({ engine: 'custom', customSocket: customSocketDraft });
  };

  const handleNetworkChange = (value: boolean) => {
    if (value) {
      setPendingWarning({ kind: 'network' });
      return;
    }
    void applyAndRefresh({ allowNetwork: false });
  };

  const confirmWarning = () => {
    if (pendingWarning?.kind === 'host') void applyAndRefresh({ mode: 'host' });
    else if (pendingWarning?.kind === 'network') void applyAndRefresh({ allowNetwork: true });
    setPendingWarning(null);
  };

  const body = () => {
    if (!isAdmin) {
      if (configLoading || !config) {
        return (
          <Box className="flex-1 items-center justify-center p-6">
            <Spinner />
          </Box>
        );
      }
      return (
        <VStack space="md" className="p-4">
          <SandboxStatusCard
            mode={config.sandbox.mode}
            available={config.sandbox.available}
            reason={config.sandbox.reason}
            showFixes
          />
          <Text size="xs" className="text-muted-foreground">
            Sandbox mode, engine, and network access are set by an administrator.
          </Text>
        </VStack>
      );
    }

    if (settingsLoading || !settings) {
      return (
        <Box className="flex-1 items-center justify-center p-6">
          <Spinner />
        </Box>
      );
    }

    return (
      <VStack space="lg" className="p-4">
        <SandboxStatusCard mode={settings.mode} available={settings.available} reason={settings.reason} />

        <ModePicker
          mode={settings.mode}
          disabled={settings.envOverrides.mode}
          onSelect={handleModeSelect}
        />
        {settings.envOverrides.mode && (
          <Text size="2xs" className="-mt-3 text-muted-foreground">
            Set by the SANDBOX_MODE environment variable.
          </Text>
        )}

        {settings.mode === 'container' && (
          <>
            <EnginePicker
              // Clicking "Custom" reveals the socket field locally before any
              // socket has been submitted — settings.engine only becomes
              // "custom" server-side once handleCustomSocketSubmit fires, so
              // driving this off it alone would make Custom unreachable.
              engine={customSocketDraft !== null ? 'custom' : settings.engine}
              customSocket={customSocketDraft ?? settings.customSocket ?? ''}
              engines={settings.engines}
              disabled={settings.envOverrides.socket}
              onSelect={handleEngineSelect}
              onCustomSocketChange={setCustomSocketDraft}
              onCustomSocketSubmit={handleCustomSocketSubmit}
            />
            {settings.envOverrides.socket && (
              <Text size="2xs" className="-mt-3 text-muted-foreground">
                Set by the CONTAINER_SOCKET environment variable.
              </Text>
            )}
          </>
        )}

        <NetworkToggle
          mode={settings.mode}
          allowNetwork={settings.allowNetwork}
          disabled={settings.envOverrides.allowNetwork}
          onChange={handleNetworkChange}
        />
        {settings.envOverrides.allowNetwork && (
          <Text size="2xs" className="-mt-3 text-muted-foreground">
            Set by the SANDBOX_ALLOW_NETWORK environment variable.
          </Text>
        )}
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Agent Sandbox"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
      />
      <ScrollView className="flex-1">{body()}</ScrollView>

      <WarningConfirmModal
        open={pendingWarning?.kind === 'host'}
        title="Disable sandbox isolation?"
        message="In host mode, agent commands (bash, file edits) run directly on this machine with no isolation. Only enable this if you trust everything the agent might be asked to run — this affects every user on this deployment."
        confirmLabel="Enable host mode"
        testIDPrefix="sandbox.hostWarning"
        onConfirm={confirmWarning}
        onCancel={() => { setPendingWarning(null); }}
      />
      <WarningConfirmModal
        open={pendingWarning?.kind === 'network'}
        title="Allow sandbox network access?"
        message="Everything that runs in a sandbox is directed by the model. Giving it network access means it could send data somewhere you didn't intend, not just install dependencies. This affects every user on this deployment."
        confirmLabel="Allow network"
        testIDPrefix="sandbox.networkWarning"
        onConfirm={confirmWarning}
        onCancel={() => { setPendingWarning(null); }}
      />

      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
