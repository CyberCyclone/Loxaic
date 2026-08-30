import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MessagesSquare, PanelRight, TriangleAlert } from 'lucide-react-native';
import { findCommand } from '@shannon/api-client';
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
import { Composer } from '@/components/composer/Composer';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ModelModal } from '@/components/settings/ModelModal';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useModels } from '@/hooks/useModels';
import { useContextUsage } from '@/hooks/useContextUsage';
import { useMcpOverrides } from '@/hooks/useMcpOverrides';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSession } from '@/lib/session';
import { useThinkingLevels, useSettings } from '@/hooks/useSettings';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToastHelper } from '@/hooks/useToastHelper';

export default function AgentScreen() {
  const shell = useShell();
  const { token } = useSession();
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
    loadingModel,
    responseStartedAt,
    pendingApproval,
    iteration,
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
        {config && !config.sandbox.available && (
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
                responseStartedAt={responseStartedAt}
                pendingApproval={pendingApproval}
                onAllow={() => { if (pendingApproval) handleApprove(pendingApproval.callId); }}
                onDeny={() => { if (pendingApproval) handleDeny(pendingApproval.callId); }}
              />
              <ModeSelector mode={mode} onChange={handleModeChange} />
              <Composer
                onSend={(text) => { handleSend(text, selectedModel); }}
                onStop={handleStop}
                streaming={busy}
                modelName={selectedModel ? getName(selectedModel) : 'Select model'}
                context={context}
                onOpenModelModal={() => { setModelModalOpen(true); }}
                surface="agent"
                onRunCommand={handleRunCommand}
                commandSeed={commandSeed}
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
          onCompact={handleCompactFromInspector}
          busy={busy}
        />
      )}

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
