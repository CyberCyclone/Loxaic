import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MessagesSquare, PanelRight, SquareTerminal, TriangleAlert, WifiOff } from 'lucide-react-native';
import { findCommand } from '@loxaic/api-client';
import { OfflineBanner } from '@/components/shell/OfflineBanner';
import { useConnection } from '@/lib/connection';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Badge, BadgeText } from '@/components/ui/badge';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { ThreadList } from '@/components/chat/ThreadList';
import { AgentStream } from '@/components/agent/AgentStream';
import { Inspector } from '@/components/agent/Inspector';
import { ModeSelector } from '@/components/agent/ModeSelector';
import { WorkspaceChooser } from '@/components/agent/WorkspaceChooser';
import { WorkspacePill } from '@/components/agent/WorkspacePill';
import { TerminalPanel } from '@/components/agent/TerminalPanel';
import { Composer } from '@/components/composer/Composer';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ModelModal } from '@/components/settings/ModelModal';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useModels } from '@/hooks/useModels';
import { useContextUsage } from '@/hooks/useContextUsage';
import { useMcpOverrides } from '@/hooks/useMcpOverrides';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useWorkspaceStatus } from '@/hooks/useWorkspaceStatus';
import { useGitPanel } from '@/hooks/useGitPanel';
import { canEdit } from '@/lib/types';
import { useSession } from '@/lib/session';
import { useThinkingLevels, useSettings } from '@/hooks/useSettings';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToastHelper } from '@/hooks/useToastHelper';

export default function AgentScreen() {
  const connection = useConnection();
  const shell = useShell();
  const { token, isAdmin } = useSession();
  const router = useRouter();
  const { config } = useServerConfig();
  const breakpoint = useBreakpoint();
  const {
    runs,
    activeId,
    activeRun,
    selectRun,
    mode,
    runState,
    busy,
    stopping,
    loadingModel,
    responseStartedAt,
    pendingApproval,
    iteration,
    queuePosition,
    pendingWorkspace,
    setPendingWorkspace,
    todos,
    changedFiles,
    handleSend,
    handleStop,
    handleCommand,
    handleNewRun,
    handleModeChange,
    handleApprove,
    handleDeny,
    handleFork,
    handleDelete,
    handleRename,
    setRunModel,
  } = useAgentSession(token, () => { void refreshModels(); });
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, getWindow, isKnown } =
    useModels(token);
  const { showToast } = useToastHelper();

  const [settings] = useSettings();
  const [thinkingLevels, setThinkingLevels] = useThinkingLevels();
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The Inspector renders its own copy of the context popup outside the
  // Composer's subtree — its Compact button reaches the input through this,
  // bumping `token` so pressing it twice in a row still re-seeds. See
  // Composer's `commandSeed` prop.
  const [commandSeed, setCommandSeed] = useState<{ token: number; text: string } | null>(null);

  const thinkingLevelsById: Partial<Record<string, typeof settings.defaultThinkingLevel>> = thinkingLevels;
  const storedThinkingLevel = activeId ? thinkingLevelsById[activeId] : undefined;
  const thinkingLevel = storedThinkingLevel ?? settings.defaultThinkingLevel;
  const wide = breakpoint === 'wide';

  const prefModel = activeRun?.model;
  const selectedModel =
    (prefModel && (models.length === 0 || isKnown(prefModel)) ? prefModel : null) ??
    pendingModel ??
    defaultModel?.id ??
    '';

  const context = useContextUsage(activeRun?.msgs, selectedModel ? getWindow(selectedModel) : null);
  const mcpOverrides = useMcpOverrides(token, activeId);
  // Refetched whenever a run ends: a turn that used a tool is exactly what
  // creates a workspace, or brings a paused one back, and nothing else in the
  // stream says so.
  const { sandbox } = useWorkspaceStatus(activeId, runState);
  // The banner is about *this* workspace's network, which is fixed at its
  // creation (the row records it), not the server-wide setting, which only
  // says what the next one gets. Keyed on the setting alone, it vanished the
  // moment an admin turned networking on — from exactly the workspace it
  // still applied to, since a resumed container keeps its NetworkMode — and
  // appeared, falsely, on a networked workspace when the setting went off.
  // A row that predates the fact falls back to the setting.
  const workspaceHasNoNetwork =
    sandbox?.limits?.network === undefined ? !(config?.sandbox.allowNetwork ?? true) : !sandbox.limits.network;
  // Before a run exists the pill and Inspector show the *pending* choice;
  // once it does, they show the run's own, which is fixed.
  const currentWorkspace = activeRun ? (activeRun.workspace ?? null) : pendingWorkspace;
  const workspace = config
    ? { retention: config.sandbox.retention, sandbox, workspace: currentWorkspace }
    : null;
  // Only a real (server-assigned) github workspace has anything to fetch —
  // an optimistic `pending-*`/`lm*` id has never been seen by the server, and
  // a scratch conversation has no /git/status to ask. Mounted regardless of
  // which; useGitPanel itself resolves a 404/400 to a null status, which the
  // Inspector already renders as "show nothing".
  const gitPanel = useGitPanel(activeId, runState);
  const gitControls =
    currentWorkspace?.kind === 'github'
      ? {
          status: gitPanel.status,
          disabled: gitPanel.busy || busy,
          gitBusy: gitPanel.busy,
          // useGitPanel resolves null on failure (it has shown the toast);
          // the boolean is what lets the panel clear a field on success only.
          onCommit: (message: string) => gitPanel.commit(message).then((r) => r !== null),
          onPush: () => { void gitPanel.push(); },
          onOpenPr: (title: string) => gitPanel.openPr(title).then((r) => r !== null),
        }
      : null;
  const [chooserOpen, setChooserOpen] = useState(false);
  // The terminal opens into the conversation's *existing* workspace, so it is
  // only offered once there is a run to have one — and it holds a socket (and,
  // on a local workspace, a shell) only while it is open.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const mcpControls =
    mcpOverrides.servers.length > 0
      ? { servers: mcpOverrides.servers, disabledIds: mcpOverrides.disabledIds, onToggle: mcpOverrides.toggle }
      : null;

  const handleRunCommand = useCallback(
    (name: string, args: string) => {
      const cmd = findCommand(name);
      if (cmd?.requiresConversation && !activeId) {
        showToast('Start a run first');
        return;
      }
      handleCommand(name, args, selectedModel);
    },
    [activeId, selectedModel, handleCommand, showToast],
  );

  // The Inspector's own Compact button (outside the Composer) seeds the
  // input the same way the ring popup's does inside it, then — narrow layout
  // only — dismisses the Actionsheet so the composer with the seeded text is
  // actually visible.
  const handleCompactFromInspector = useCallback(() => {
    setCommandSeed({ token: Date.now(), text: '/compact ' });
    if (!wide) setInspectorOpen(false);
  }, [wide]);

  const threadList = (
    <ThreadList
      title="Agent Runs"
      conversations={runs}
      activeId={activeId}
      onSelect={(id) => {
        selectRun(id);
        setThreadListOpen(false);
      }}
      onNewChat={() => {
        handleNewRun();
        setThreadListOpen(false);
      }}
      onFork={handleFork}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );

  return (
    <HStack className="h-full flex-1">
      {wide && threadList}

      <VStack className="h-full flex-1">
        <MainHeader
          title={activeRun?.title ?? 'Agent'}
          onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
          right={
            <HStack space="sm" className="items-center">
              {activeRun && (
                <Pressable
                  testID="agent.terminal.toggle"
                  onPress={() => { setTerminalOpen((o) => !o); }}
                  className={`rounded-sm p-1.5 web:hover:bg-muted/50 ${terminalOpen ? 'bg-muted' : ''}`}
                >
                  <Icon as={SquareTerminal} size="sm" className="text-foreground" />
                </Pressable>
              )}
              {activeRun && (
                <Pressable
                  testID="agent.inspector.toggle"
                  onPress={() => { setInspectorOpen((o) => !o); }}
                  className="flex-row items-center gap-1 rounded-sm p-1.5 web:hover:bg-muted/50"
                >
                  <Icon as={PanelRight} size="sm" className="text-foreground" />
                  {changedFiles.length > 0 && (
                    <Badge variant="destructive">
                      <BadgeText className="text-2xs normal-case">{changedFiles.length}</BadgeText>
                    </Badge>
                  )}
                </Pressable>
              )}
              {!wide && (
                <Pressable
                  testID="agent.threadList.toggle"
                  onPress={() => { setThreadListOpen(true); }}
                  className="rounded-sm p-1.5 web:hover:bg-muted/50"
                >
                  <Icon as={MessagesSquare} size="sm" className="text-foreground" />
                </Pressable>
              )}
            </HStack>
          }
        />
        {/* Not for a local workspace: the server's sandbox posture says
            nothing about the user's own machine, and "tools unavailable"
            would be wrong exactly when they are about to work. */}
        {config && !config.sandbox.available && currentWorkspace?.kind !== 'local' && (
          <Pressable
            testID="agent.sandbox.banner"
            onPress={() => { router.push('/sandbox'); }}
            className="flex-row items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2 web:hover:bg-destructive/15"
          >
            <Icon as={TriangleAlert} size="xs" className="text-destructive" />
            <Text size="xs" className="flex-1 text-destructive" numberOfLines={1}>
              Agent tools are unavailable{config.sandbox.reason ? `: ${config.sandbox.reason}` : ''}
            </Text>
            <Text size="xs" className="text-destructive underline">
              Fix
            </Text>
          </Pressable>
        )}
        {/* Sandboxes are created with no network unless an admin turns it on,
            and nothing else says so — the model finds out by watching
            `npm install` fail, which costs a tool call and reads to the user
            as the agent being broken. Warning rather than destructive: tools
            do work, they just cannot reach the internet.

            Same `local` exclusion as the banner above, for the same reason,
            plus one of its own: a local container deliberately *has* the
            network (the user already agreed to run these commands on their own
            machine), so the server's setting would be doubly wrong here. */}
        {config && config.sandbox.available && workspaceHasNoNetwork
          && currentWorkspace?.kind !== 'local' && (
          <Pressable
            testID="agent.network.banner"
            onPress={() => { router.push('/sandbox'); }}
            className="flex-row items-center gap-2 border-b border-border bg-warning/10 px-3 py-2 web:hover:bg-warning/15"
          >
            <Icon as={WifiOff} size="xs" className="text-warning" />
            <VStack className="flex-1">
              <Text size="xs" className="font-medium text-warning">
                This workspace has no network access — npm install, git clone and other downloads will fail.
              </Text>
              <Text size="2xs" className="text-warning/80">
                {config.sandbox.allowNetwork
                  ? 'Network access is on for new workspaces now, but this one keeps the network it was created with — start a new conversation to pick it up.'
                  : isAdmin
                    ? 'Turn it on in Agent Sandbox settings. New workspaces pick it up; this one keeps the network it was created with.'
                    : 'An admin can turn it on in Agent Sandbox settings. New workspaces pick it up; this one keeps the network it was created with.'}
              </Text>
            </VStack>
            <Text size="xs" className="text-warning underline">
              {isAdmin && !config.sandbox.allowNetwork ? 'Fix' : 'Details'}
            </Text>
          </Pressable>
        )}
        <OfflineBanner />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <HStack className="flex-1 overflow-hidden">
            <VStack className="flex-1">
              <AgentStream
                run={activeRun}
                state={runState}
                mode={mode}
                iteration={iteration}
                loadingModel={loadingModel}
                queuePosition={queuePosition}
                responseStartedAt={responseStartedAt}
                pendingApproval={pendingApproval}
                onAllow={() => { if (pendingApproval) handleApprove(pendingApproval.callId); }}
                onDeny={() => { if (pendingApproval) handleDeny(pendingApproval.callId); }}
              />
              <TerminalPanel
                conversationId={activeRun?.id ?? null}
                token={token}
                open={terminalOpen && !!activeRun}
                onClose={() => { setTerminalOpen(false); }}
              />
              <HStack className="items-center justify-between pr-3">
                <ModeSelector mode={mode} onChange={handleModeChange} />
                <WorkspacePill
                  workspace={currentWorkspace}
                  editable={!activeRun}
                  onPress={() => { setChooserOpen(true); }}
                />
              </HStack>
              <Composer
                onSend={(text, attachments) => { handleSend(text, selectedModel, attachments); }}
                onStop={handleStop}
                stopping={stopping}
                streaming={busy}
                modelName={selectedModel ? getName(selectedModel) : 'Select model'}
                context={context}
                onOpenModelModal={() => { setModelModalOpen(true); }}
                surface="agent"
                onRunCommand={handleRunCommand}
                commandSeed={commandSeed}
                readOnlyReason={
                  activeRun && !canEdit(activeRun)
                    ? 'This run is shared with you for viewing. You can follow it as it happens, but not send.'
                    : connection === 'online'
                      ? null
                      : "You're offline. This is your saved copy of the run — sending will work again once your server is reachable."
                }
              />
            </VStack>

            {wide && (
              <Inspector
                open={inspectorOpen}
                onClose={() => { setInspectorOpen(false); }}
                wide
                todos={todos}
                changedFiles={changedFiles}
                context={context}
                mcp={mcpControls}
                workspace={workspace}
                git={gitControls}
                onCompact={handleCompactFromInspector}
                busy={busy}
              />
            )}
          </HStack>
        </KeyboardAvoidingView>
      </VStack>

      {!wide && threadListOpen && (
        <>
          <Pressable onPress={() => { setThreadListOpen(false); }} className="absolute inset-0 bg-black/40" />
          <Box className="absolute bottom-0 right-0 top-0 shadow-lg">{threadList}</Box>
        </>
      )}

      {!wide && (
        <Inspector
          open={inspectorOpen}
          onClose={() => { setInspectorOpen(false); }}
          wide={false}
          todos={todos}
          changedFiles={changedFiles}
          context={context}
          mcp={mcpControls}
          workspace={workspace}
          git={gitControls}
          onCompact={handleCompactFromInspector}
          busy={busy}
        />
      )}

      <WorkspaceChooser
        open={chooserOpen}
        onClose={() => { setChooserOpen(false); }}
        value={pendingWorkspace}
        onChange={setPendingWorkspace}
        config={config}
        token={token}
      />
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
      <ModelModal
        open={modelModalOpen}
        onClose={() => { setModelModalOpen(false); }}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={() => { void refreshModels(); }}
        selectedModel={selectedModel}
        onSelect={(id) => {
          if (activeId) setRunModel(activeId, id);
          else setPendingModel(id);
        }}
        thinkingLevel={thinkingLevel}
        onThinkingLevel={(level) => {
          if (activeId) setThinkingLevels((prev) => ({ ...prev, [activeId]: level }));
        }}
        onOpenSettings={() => {
          setModelModalOpen(false);
          shell.openSettings();
        }}
      />
    </HStack>
  );
}
