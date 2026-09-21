import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { AgentStepLimit } from '@/components/settings/AgentStepLimit';
import { WaitTimeout } from '@/components/settings/WaitTimeout';
import { AdaptiveTimeoutToggle } from '@/components/settings/AdaptiveTimeoutToggle';
import { UnattendedCheckins } from '@/components/settings/UnattendedCheckins';
import { LoopSensitivity } from '@/components/settings/LoopSensitivity';
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

        <AgentStepLimit />

        {prefs.checkinTimeoutMs !== undefined && (
          <WaitTimeout
            label="Wait for an answer to a check-in"
            help="How long a check-in waits before doing what is set below. A waiting run gives its place in the queue back, so waiting longer holds up nobody else."
            value={prefs.checkinTimeoutMs}
            serverDefaultMs={prefs.serverDefaults?.checkinTimeoutMs}
            onChoose={(v) => { save({ checkinTimeoutMs: v }); }}
            disabled={busy}
            testIDPrefix="settings.checkinTimeout"
          />
        )}

        {prefs.checkinAutoContinues !== undefined && (
          <UnattendedCheckins
            value={prefs.checkinAutoContinues}
            stepsPerWindow={prefs.maxIterations}
            onChoose={(v) => { save({ checkinAutoContinues: v }); }}
            disabled={busy}
          />
        )}

        {prefs.approvalTimeoutMs !== undefined && (
          <WaitTimeout
            label="Wait for a tool approval"
            help="How long a request to run a tool waits for you. If nobody answers, that call does not run and the agent is told nobody answered — not that you refused."
            value={prefs.approvalTimeoutMs}
            serverDefaultMs={prefs.serverDefaults?.approvalTimeoutMs}
            onChoose={(v) => { save({ approvalTimeoutMs: v }); }}
            disabled={busy}
            testIDPrefix="settings.approvalTimeout"
          />
        )}

        {prefs.adaptiveTimeout !== undefined && (
          <AdaptiveTimeoutToggle
            value={prefs.adaptiveTimeout}
            onChange={(v) => { save({ adaptiveTimeout: v }); }}
            disabled={busy}
          />
        )}

        {prefs.loopSensitivity !== undefined && (
          <LoopSensitivity
            value={prefs.loopSensitivity}
            onChoose={(v) => { save({ loopSensitivity: v }); }}
            disabled={busy}
          />
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
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
