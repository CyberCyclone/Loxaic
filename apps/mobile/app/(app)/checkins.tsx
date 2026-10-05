import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { AgentStepLimit } from '@/components/settings/AgentStepLimit';
import { WaitTimeout } from '@/components/settings/WaitTimeout';
import { AdaptiveTimeoutToggle } from '@/components/settings/AdaptiveTimeoutToggle';
import { UnattendedCheckins } from '@/components/settings/UnattendedCheckins';
import { LoopSensitivity } from '@/components/settings/LoopSensitivity';
import { SubAgentModel } from '@/components/settings/SubAgentModel';
import { ModelModal } from '@/components/settings/ModelModal';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';
import { usePrefs } from '@/hooks/usePrefs';

/**
 * Everything about when a run stops to ask a person, and what it does when
 * nobody answers. A screen of its own rather than rows in the settings modal:
 * that modal has run past the fold twice already, and these settings only
 * make sense read together.
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
          The agent stops to ask before it runs a tool that needs your approval, and every so many
          steps to ask whether it should keep going. These settings decide how long it waits for you
          and what it does if you are away.
        </Text>

        {/* `!= null` hides it against a server that predates the field, which
            answers 200 with the key simply absent. */}
        {prefs.maxIterations != null && (
          <AgentStepLimit
            value={prefs.maxIterations}
            onChoose={(v) => { save({ maxIterations: v }); }}
            disabled={locked}
          />
        )}

        {prefs.checkinTimeoutMs !== undefined && (
          <WaitTimeout
            label="Wait for an answer to a check-in"
            help="How long a check-in waits before doing what is set below. A waiting run gives its place in the queue back, so waiting longer holds up nobody else."
            value={prefs.checkinTimeoutMs}
            serverDefaultMs={prefs.serverDefaults?.checkinTimeoutMs}
            onChoose={(v) => { save({ checkinTimeoutMs: v }); }}
            disabled={locked}
            testIDPrefix="settings.checkinTimeout"
          />
        )}

        {prefs.checkinAutoContinues !== undefined && (
          <UnattendedCheckins
            value={prefs.checkinAutoContinues}
            stepsPerWindow={prefs.maxIterations}
            onChoose={(v) => { save({ checkinAutoContinues: v }); }}
            disabled={locked}
          />
        )}

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

        {prefs.loopSensitivity !== undefined && (
          <LoopSensitivity
            value={prefs.loopSensitivity}
            onChoose={(v) => { save({ loopSensitivity: v }); }}
            disabled={locked}
          />
        )}

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
      <MainHeader title="Check-ins & approvals" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="checkins.scroll" className="flex-1">
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
