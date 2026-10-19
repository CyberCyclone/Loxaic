import { useState } from 'react';
import { ScrollView } from 'react-native';
import { VStack } from '@/components/ui/vstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { RunQueueSettings } from '@/components/server/RunQueueSettings';
import { PermissionCheckSettings } from '@/components/server/PermissionCheckSettings';
import { ModelModal } from '@/components/settings/ModelModal';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { useInferenceSettings } from '@/hooks/useInferenceSettings';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';

/**
 * Settings that apply to every conversation on this server, whatever surface
 * it is on: how many runs share the backend, and auto mode's permission
 * check. Admin only. The Agent Sandbox screen is for where tool calls run.
 */
export default function ServerScreen() {
  const shell = useShell();
  const reachable = useServerReachable();
  const { token, isAdmin } = useSession();
  const { settings: inference, update: updateInference } = useInferenceSettings(isAdmin ? token : null);
  // The permission check's model, picked from the same list a chat uses.
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, getName, isKnown } = useModels(isAdmin ? token : null);
  const { recentModels, refreshRecentModels } = useRecentModels(isAdmin ? token : null);
  const [pickingCheckModel, setPickingCheckModel] = useState(false);

  const body = () => {
    if (!isAdmin) {
      return (
        <Text testID="server.readOnly.notice" size="xs" className="p-4 text-muted-foreground">
          Server settings are set by an administrator.
        </Text>
      );
    }
    if (!inference) {
      return (
        <Box className="flex-1 items-center justify-center p-6">
          <Spinner />
        </Box>
      );
    }
    return (
      <VStack space="lg" className="p-4">
        <RunQueueSettings
          settings={inference}
          onChange={(value) => { void updateInference({ maxConcurrentRuns: value }); }}
          unavailable={!reachable}
        />

        {/* Hidden against a server that predates the permission check. */}
        {inference.permissionCheckTimeoutMs !== undefined && (
          <PermissionCheckSettings
            settings={inference}
            modelName={inference.permissionCheckModel && isKnown(inference.permissionCheckModel) ? getName(inference.permissionCheckModel) : null}
            onUseRunModel={() => { void updateInference({ permissionCheckModel: null }); }}
            onPickModel={() => { setPickingCheckModel(true); }}
            onTimeout={(ms) => { void updateInference({ permissionCheckTimeoutMs: ms }); }}
            unavailable={!reachable}
          />
        )}
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Server Settings" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="server.screen" className="flex-1">{body()}</ScrollView>
      <ModelModal
        open={pickingCheckModel}
        onClose={() => { setPickingCheckModel(false); }}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={() => {
          void refreshModels();
          void refreshRecentModels();
        }}
        selectedModel={inference?.permissionCheckModel ?? ''}
        recentModels={recentModels}
        onSelect={(id) => {
          void updateInference({ permissionCheckModel: id });
          setPickingCheckModel(false);
        }}
        onOpenSettings={() => {
          setPickingCheckModel(false);
          shell.openSettings();
        }}
      />
    </VStack>
  );
}
