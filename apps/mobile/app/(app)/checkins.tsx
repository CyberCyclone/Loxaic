import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { WaitTimeout } from '@/components/settings/WaitTimeout';
import { AdaptiveTimeoutToggle } from '@/components/settings/AdaptiveTimeoutToggle';
import { ProgressReviewSettings } from '@/components/settings/ProgressReviewSettings';
import { SubAgentModel } from '@/components/settings/SubAgentModel';
import { ModelModal } from '@/components/settings/ModelModal';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';
import { usePrefs } from '@/hooks/usePrefs';

/**
 * Approvals & progress: how long a run waits for a person to approve a tool,
 * and how a long run is kept from going nowhere (the progress review). A
 * screen of its own rather than rows in the settings modal: that modal has run
 * past the fold twice already, and these settings only make sense read
 * together. The route keeps its old name (`checkins`), which links point at.
 *
 * Each control hides itself when the server does not report its field — an
 * older server simply has no such setting.
 */
export default function CheckinsScreen() {
  const shell = useShell();
  const { prefs, loading, busy, save } = usePrefs();
  // Every row saves on the server.
  const reachable = useServerReachable();
  const locked = busy || !reachable;
  // For the sub-agent model: the list to pick a fixed one from.
  const { token } = useSession();
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, getName, isKnown } = useModels(token);
  const { recentModels, refreshRecentModels } = useRecentModels(token);
  const [pickingModel, setPickingModel] = useState(false);

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
        <Text testID="checkins.unavailable" size="sm" className="p-4 text-muted-foreground">
          These settings could not be loaded. Check the connection to the server.
        </Text>
      );
    }
    return (
      <VStack space="lg" className="p-4">
        <Text size="xs" className="text-muted-foreground">
          The agent stops to ask before it runs a tool that needs your approval, and a progress review
          keeps a long run from going nowhere without asking you anything. These settings decide how
          long an approval waits for you, and how often a run is reviewed.
        </Text>

        {prefs.approvalTimeoutMs !== undefined && (
          <WaitTimeout
            label="Wait for a tool approval"
            help="How long a request to run a tool waits for you. If nobody answers, that call does not run and the agent is told nobody answered — not that you refused."
            value={prefs.approvalTimeoutMs}
            serverDefaultMs={prefs.serverDefaults?.approvalTimeoutMs}
            onChoose={(v) => { save({ approvalTimeoutMs: v }); }}
            disabled={locked}
            testIDPrefix="settings.approvalTimeout"
          />
        )}

        {prefs.adaptiveTimeout !== undefined && (
          <AdaptiveTimeoutToggle
            value={prefs.adaptiveTimeout}
            onChange={(v) => { save({ adaptiveTimeout: v }); }}
            disabled={locked}
          />
        )}

        <ProgressReviewSettings prefs={prefs} save={save} disabled={locked} />

        {/* Hidden against a server that predates sub-agents, like every row
            above against one that predates its field. */}
        {prefs.subagentModelMode !== undefined && (
          <VStack testID="checkins.subagents" space="sm" className="border-t border-border pt-4">
            <Text size="sm" className="font-medium text-foreground">
              Sub-agents
            </Text>
            <Text size="xs" className="text-muted-foreground">
              The agent can hand part of its work to a sub-agent: a separate agent with its own context that
              works in the same workspace and reports back. A sub-agent asks before it runs a tool exactly as
              the agent does, and you can open or stop one from its card or from the ⋮ menu.
            </Text>
            <SubAgentModel
              mode={prefs.subagentModelMode}
              model={prefs.subagentModel ?? null}
              modelName={prefs.subagentModel && isKnown(prefs.subagentModel) ? getName(prefs.subagentModel) : null}
              onChooseMode={(mode) => { save({ subagentModelMode: mode }); }}
              onPickModel={() => { setPickingModel(true); }}
              disabled={locked}
            />
          </VStack>
        )}
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Approvals & progress" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="checkins.scroll" className="flex-1" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {body()}
      </ScrollView>
      <ModelModal
        open={pickingModel}
        onClose={() => { setPickingModel(false); }}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={() => {
          void refreshModels();
          void refreshRecentModels();
        }}
        selectedModel={prefs?.subagentModel ?? ''}
        recentModels={recentModels}
        onSelect={(id) => {
          // Both at once: the server refuses `fixed` without a model, and a
          // model saved without the mode would change nothing a person can see.
          save({ subagentModelMode: 'fixed', subagentModel: id });
          setPickingModel(false);
        }}
        onOpenSettings={() => {
          setPickingModel(false);
          shell.openSettings();
        }}
      />
    </VStack>
  );
}
