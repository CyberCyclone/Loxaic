import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MessagesSquare, PanelRight, SquareTerminal, TriangleAlert, WifiOff } from 'lucide-react-native';
import { findCommand } from '@loxaic/api-client';
import type { McpOverrides, ThinkingLevel } from '@loxaic/types';
import { disconnectedCopy, showsDisconnected, useConnection } from '@/lib/connection';
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
import { ModelModal } from '@/components/settings/ModelModal';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { pickSelectedModel } from '@/lib/selectModel';
import { useContextUsage } from '@/hooks/useContextUsage';
import { useMcpSwitches } from '@/hooks/useMcpSwitches';
import { useContextStages } from '@/hooks/useContextStages';
import { ContextStageModal } from '@/components/context/ContextStageModal';
import { ContextSettingsSheet } from '@/components/context/ContextSettingsSheet';
import { formatWindow } from '@/lib/contextStages';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useWorkspaceStatus } from '@/hooks/useWorkspaceStatus';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useGitPanel } from '@/hooks/useGitPanel';
import { canEdit, isOwner } from '@/lib/types';
import { ConversationMenu } from '@/components/chat/ConversationMenu';
import { PlanReviewContext, type PlanReview } from '@/components/chat/PlanCard';
import { PlanPanel } from '@/components/agent/PlanPanel';
import { PlanReviewBar } from '@/components/agent/PlanReviewBar';
import { QuestionsPanel } from '@/components/agent/QuestionsPanel';
import { useReview } from '@/hooks/useReview';
import { useSubAgents } from '@/hooks/useSubAgents';
import { SubAgentContext } from '@/components/subagents/SubAgentContext';
import { SubAgentPanel } from '@/components/subagents/SubAgentPanel';
import { SubAgentsList } from '@/components/subagents/SubAgentsList';
import { PLAN_ACCEPTED_MESSAGE, PLAN_REJECTED_MESSAGE, acceptMode, formatAnswers, type PlanStatus, type QuestionsStatus } from '@/lib/plan';
import { DeleteConversationModal } from '@/components/chat/DeleteConversationModal';
import { NoRoomModal } from '@/components/chat/NoRoomModal';
import { useSession } from '@/lib/session';
import { useSettings } from '@/hooks/useSettings';
import { useThinkingChoice } from '@/hooks/useThinkingChoice';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToastHelper } from '@/hooks/useToastHelper';

/** Stable, so a screen with no run open does not hand useReview a new
 * array — and so a new list of plans — on every render. */
const NO_MESSAGES: never[] = [];

/** Long enough for the plan sheet's exit animation (200ms) to finish. */
const SHEET_EXIT_MS = 300;

export default function AgentScreen() {
  const connection = useConnection();
  const shell = useShell();
  const { token, isAdmin } = useSession();
  const router = useRouter();
  const { config } = useServerConfig();
  const breakpoint = useBreakpoint();
  const pendingMcpRef = useRef<McpOverrides | undefined>(undefined);
  // The context stage chosen for a run that does not exist yet; read by the
  // session at send time, like the MCP choices above.
  const pendingStageRef = useRef<number | undefined>(undefined);
  const thinkingRef = useRef<ThinkingLevel | undefined>(undefined);
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
    promptStats,
    responseStartedAt,
    pendingApproval,
    pendingCheckin,
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
    handleSteps,
    handleFork,
    handleDelete,
    handleRename,
    setRunModel,
    history,
    noRoom,
    dismissNoRoom,
    returnedText,
    promotion,
    stageCard,
    subAgents: subAgentState,
  } = useAgentSession(token, () => { void refreshModels(); }, pendingMcpRef, pendingStageRef, thinkingRef);
  // This run's sub-agents: their cards, the list behind the ⋮ item, the open
  // panel, and the approval to show when the run itself is not asking.
  // Stopping one and answering it are editor actions, as they are on the run.
  const subAgents = useSubAgents(subAgentState, activeId, Boolean(activeRun && canEdit(activeRun)));
  // One approval at a time, the run's own first: it is the one the composer's
  // Stop and the header are already about. A sub-agent's follows, named.
  const childApproval = pendingApproval ? null : subAgents.approvalChild;
  const shownApproval = pendingApproval ?? childApproval?.approval ?? null;
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, getWindow, isKnown } =
    useModels(token);
  const { recentModels, refreshRecentModels, bumpRecentModel } = useRecentModels(token);
  const { showToast } = useToastHelper();

  const [settings] = useSettings();
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Set by both the header's ⋮ and the thread list's Delete, so one dialog
  // words what deleting does on this deployment.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The Inspector renders its own copy of the context popup outside the
  // Composer's subtree — its Compact button reaches the input through this,
  // bumping `token` so pressing it twice in a row still re-seeds. See
  // Composer's `commandSeed` prop.
  const [commandSeed, setCommandSeed] = useState<{ token: number; text: string } | null>(null);
  // A send the server never heard of comes back to the message box.
  useEffect(() => { if (returnedText) setCommandSeed(returnedText); }, [returnedText]);

  const wide = breakpoint === 'wide';

  const prefModel = activeRun?.model;
  // See lib/selectModel.ts for the order, and for why "last used" applies only
  // to a conversation that does not exist yet.
  const selectedModel = pickSelectedModel({
    prefModel,
    hasConversation: Boolean(activeId),
    pendingModel,
    recentModels,
    modelsLoaded: models.length > 0,
    isKnown,
    defaultModelId: defaultModel?.id,
  });

  // The level every send carries, read by the session at send time.
  const thinking = useThinkingChoice({
    activeId,
    promotion,
    model: models.find((m) => m.id === selectedModel),
    modelsLoaded: models.length > 0,
  });
  thinkingRef.current = thinking.level;

  const context = useContextUsage(activeRun?.msgs, selectedModel ? getWindow(selectedModel) : null);
  // One instance for the composer's `+` menu, the context popup and the
  // Inspector. Read by the session at send time; see its `pendingMcp`.
  const mcp = useMcpSwitches(token, activeId, 'agent', promotion);
  pendingMcpRef.current = mcp.pendingOverrides;
  // Refetched whenever a run ends: a turn that used a tool is exactly what
  // creates a workspace, or brings a paused one back, and nothing else in the
  // stream says so.
  const { sandbox } = useWorkspaceStatus(activeId, runState);
  // Looked for on the conversation's first run, so asked again as runs end.
  const instructions = useProjectInstructions(activeRun ? activeId : null, runState);
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
    ? { retention: config.sandbox.retention, sandbox, workspace: currentWorkspace, instructions }
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
          // A commit, push or PR is a request to the server.
          disabled: gitPanel.busy || busy || connection !== 'online',
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

  const readOnlyReason =
    activeRun && !canEdit(activeRun)
      ? 'This run is shared with you for viewing. You can follow it as it happens, but not send.'
      : !showsDisconnected(connection)
        ? null
        : disconnectedCopy(connection).readOnly('run');

  // A host model with YaRN stages — see chat.tsx.
  const stages = useContextStages({
    token,
    model: selectedModel || undefined,
    models,
    conversationId: activeId,
    context,
    streaming: busy,
    readOnly: readOnlyReason !== null,
    isAdmin,
    onCompact: () => { handleRunCommand('compact', ''); },
    refreshModels: () => { void refreshModels(); },
    stageCard,
    promotion,
  });
  pendingStageRef.current = stages.pendingStage;

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
      onDelete={(id) => { setDeletingId(id); }}
    />
  );

  const deletingRun = runs.find((r) => r.id === deletingId) ?? null;

  // ── Plans (#199) ─────────────────────────────────────────
  // Why a panel's buttons are not offered right now, or null when they are —
  // worded for what the panel is holding, a plan or questions.
  const blockedReason = (what: 'decide on this plan' | 'answer these questions'): string | null =>
    activeRun && !canEdit(activeRun)
      ? `This run is shared with you for viewing — only the people who can send in it can ${what}.`
      : showsDisconnected(connection)
        ? disconnectedCopy(connection).note(what)
        : connection !== 'online'
          // A grace period: the decision waits for the socket, briefly.
          ? 'Connecting to your server…'
          : busy
            ? 'The agent is still working in this conversation.'
            : null;
  const planReview = useReview({
    convId: activeId,
    msgs: activeRun?.msgs ?? NO_MESSAGES,
    busy,
    canDecide: Boolean(activeRun && canEdit(activeRun)) && connection === 'online',
    blocked: subAgents.sheetOpen,
  });
  const planContext = useMemo<PlanReview>(
    () => ({ open: planReview.openItem, statusOf: planReview.statusOf }),
    [planReview.openItem, planReview.statusOf],
  );
  const planMode = acceptMode(settings.defaultMode);
  // The model Accept runs the work on — the conversation's own until someone
  // picks another in the panel. Keyed to the plan, so a choice made for one
  // plan never carries silently onto the next.
  const [planModelChoice, setPlanModelChoice] = useState<{ callId: string; model: string } | null>(null);
  const openPlan = planReview.open?.kind === 'plan' ? planReview.open : null;
  const openQuestions = planReview.open?.kind === 'questions' ? planReview.open : null;
  const openPlanId = openPlan?.callId ?? null;
  const executionModel =
    (openPlanId !== null && planModelChoice?.callId === openPlanId ? planModelChoice.model : undefined) ?? selectedModel;
  // Choosing a model swaps the panel for the model list and back: the two are
  // siblings, never stacked (see RoutineModal in AGENTS.md).
  const [pickingPlanModel, setPickingPlanModel] = useState<string | null>(null);
  // The model list opens a moment after the sheet starts closing (see
  // onPickModel), so the timer is kept to be called off. A plan that goes away
  // in the meantime — another thread opened, the screen left — must not have
  // the list open over whatever is there now, nor have the choice made in it
  // written against a plan nobody is looking at while the conversation's own
  // model goes unchanged.
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pickingPlanModel === null || pickingPlanModel === openPlanId) return;
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = null;
    setPickingPlanModel(null);
    setModelModalOpen(false);
  }, [pickingPlanModel, openPlanId]);
  useEffect(
    () => () => {
      if (pickTimer.current) clearTimeout(pickTimer.current);
    },
    [],
  );
  // Every decision is an ordinary send, in the mode the decision implies — see
  // PLAN_ACCEPTED_MESSAGE for why the words are fixed.
  // Sent first, and only then acted on. It used to close the panel and switch
  // the model before sending, so a decision that never left looked made: the
  // panel was gone, the model had changed, and the plan read "accepted"
  // (its status comes from the message after it, which was on screen).
  const decidePlan = (text: string, decisionMode: 'planning' | 'manual' | 'auto', model: string) => {
    if (!handleSend(text, model, undefined, decisionMode)) return;
    planReview.close();
    if (model !== selectedModel && activeId) setRunModel(activeId, model);
    bumpRecentModel(model);
  };

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
              {/* Each item is gated on its own: View plan for anyone who can
                  see the run, Delete for its owner only. */}
              {activeRun && (
                <ConversationMenu
                  area="agent"
                  onDelete={isOwner(activeRun) ? () => { setDeletingId(activeRun.id); } : undefined}
                  subAgents={{ open: subAgents.openList, running: subAgents.running }}
                  review={
                    planReview.latest
                      ? {
                          kind: planReview.latest.kind,
                          open: () => { if (planReview.latest) planReview.openItem(planReview.latest.callId); },
                        }
                      : undefined
                  }
                />
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
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <HStack className="flex-1 overflow-hidden">
            <VStack className="flex-1">
              <PlanReviewContext.Provider value={planContext}>
                <SubAgentContext.Provider value={subAgents.ui}>
                  <AgentStream
                    run={activeRun}
                    state={runState}
                    mode={mode}
                    iteration={iteration}
                    loadingModel={loadingModel}
                    promptStats={promptStats}
                    queuePosition={queuePosition}
                    responseStartedAt={responseStartedAt}
                    pendingApproval={shownApproval}
                    // Who is asking, when it is a sub-agent rather than the run.
                    approvalSource={childApproval?.description}
                    pendingCheckin={pendingCheckin}
                    history={history}
                    stageCard={stageCard}
                    onAllow={() => {
                      if (pendingApproval) handleApprove(pendingApproval.callId);
                      else if (childApproval) subAgents.answer(childApproval.conversation_id, true);
                    }}
                    onDeny={() => {
                      if (pendingApproval) handleDeny(pendingApproval.callId);
                      else if (childApproval) subAgents.answer(childApproval.conversation_id, false);
                    }}
                    onCheckinContinue={() => { handleSteps('continue'); }}
                    onCheckinAnswer={() => { handleSteps('answer'); }}
                    onCheckinStop={handleStop}
                  />
                </SubAgentContext.Provider>
              </PlanReviewContext.Provider>
              <TerminalPanel
                conversationId={activeRun?.id ?? null}
                token={token}
                open={terminalOpen && !!activeRun}
                onClose={() => { setTerminalOpen(false); }}
              />
              {planReview.showBar && planReview.latest && (
                <PlanReviewBar
                  item={planReview.latest}
                  status={planReview.latestStatus}
                  busy={busy}
                  onOpen={() => { if (planReview.latest) planReview.openItem(planReview.latest.callId); }}
                />
              )}
              <HStack className="items-center justify-between pr-3">
                <ModeSelector mode={mode} onChange={handleModeChange} />
                <WorkspacePill
                  workspace={currentWorkspace}
                  editable={!activeRun}
                  unavailable={connection !== 'online'}
                  onPress={() => { setChooserOpen(true); }}
                />
              </HStack>
              <Composer
                onSend={(text, attachments) => {
                  // See chat.tsx — an optimistic local reorder.
                  bumpRecentModel(selectedModel);
                  handleSend(text, selectedModel, attachments);
                }}
                onStop={handleStop}
                stopping={stopping}
                streaming={busy}
                modelName={selectedModel ? getName(selectedModel) : 'Select model'}
                context={context}
                onOpenModelModal={() => { setModelModalOpen(true); }}
                surface="agent"
                mcp={mcp}
                thinking={thinking.composer}
                onRunCommand={handleRunCommand}
                commandSeed={commandSeed}
                contextStage={
                  stages.staged
                    ? {
                        controls: stages.controls,
                        onOpenSettings: () => { stages.open({ kind: 'settings' }); },
                        chip:
                          stages.pendingStage !== undefined && stages.pendingStage > 0 && stages.stage
                            ? `Context: ${formatWindow(stages.stage.windows[stages.pendingStage])}`
                            : null,
                        onClearChip: stages.clearChoice,
                      }
                    : null
                }
                readOnlyReason={readOnlyReason}
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
                mcp={mcp}
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
          mcp={mcp}
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
      <ContextStageModal stages={stages} />
      <ContextSettingsSheet stages={stages} />
      <NoRoomModal
        notice={noRoom}
        isAdmin={isAdmin}
        onClose={() => {
          if (noRoom?.text) setCommandSeed({ token: Date.now(), text: noRoom.text });
          dismissNoRoom();
        }}
        onChooseModel={() => { setModelModalOpen(true); }}
        onManage={() => { router.push('/host-models'); }}
      />
      <DeleteConversationModal
        title={deletingRun?.title ?? null}
        area="agent"
        // Its own workspace, not the one currently selected: deleting from the
        // thread list can name a run other than the open one.
        workspaceKind={deletingRun?.workspace?.kind ?? 'scratch'}
        retentionDays={config ? config.deletedChatRetentionDays : undefined}
        onCancel={() => { setDeletingId(null); }}
        onConfirm={() => {
          const id = deletingId;
          setDeletingId(null);
          if (id) void handleDelete(id);
        }}
      />
      <PlanPanel
        plan={openPlan?.plan ?? null}
        hidden={pickingPlanModel !== null}
        status={openPlan ? (planReview.openStatus as PlanStatus | null) : null}
        blockedReason={blockedReason('decide on this plan')}
        defaultMode={planMode}
        executionModelName={executionModel ? getName(executionModel) : 'Select model'}
        onPickModel={() => {
          if (!openPlanId) return;
          setPickingPlanModel(openPlanId);
          // After the sheet has gone, not with it: iOS will not present a
          // second modal while the first is still being dismissed, and left
          // the sheet on screen behind the model list.
          pickTimer.current = setTimeout(() => {
            pickTimer.current = null;
            setModelModalOpen(true);
          }, SHEET_EXIT_MS);
        }}
        onAccept={(m) => { decidePlan(PLAN_ACCEPTED_MESSAGE, m, executionModel); }}
        onSuggest={(text) => { decidePlan(text, 'planning', selectedModel); }}
        onReject={() => { decidePlan(PLAN_REJECTED_MESSAGE, 'planning', selectedModel); }}
        onClose={planReview.close}
      />
      <SubAgentsList
        open={subAgents.listOpen}
        subAgents={subAgents.listed}
        unavailable={subAgents.listUnavailable}
        onRetry={subAgents.retryList}
        isStopping={subAgents.isStopping}
        onOpen={subAgents.openFromList}
        onClose={subAgents.closeList}
      />
      <SubAgentPanel
        view={subAgents.panel.view}
        transcript={subAgents.panel.transcript}
        stopping={subAgents.panel.stopping}
        canAct={subAgents.ui.canAct}
        onStop={subAgents.panel.stop}
        onAllow={subAgents.panel.allow}
        onDeny={subAgents.panel.deny}
        onClose={subAgents.panel.close}
      />
      <QuestionsPanel
        questions={openQuestions?.questions ?? null}
        status={openQuestions ? (planReview.openStatus as QuestionsStatus | null) : null}
        blockedReason={blockedReason('answer these questions')}
        // Answers are one message, sent in planning: the agent is still
        // refining the plan, and the reply it owes is a plan or more questions.
        onSubmit={(answers) => {
          if (openQuestions) decidePlan(formatAnswers(openQuestions.questions.questions, answers), 'planning', selectedModel);
        }}
        onClose={planReview.close}
      />
      <ModelModal
        open={modelModalOpen}
        onClose={() => {
          setModelModalOpen(false);
          // Back to the plan the model was being chosen for.
          setPickingPlanModel(null);
        }}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={() => {
          void refreshModels();
          // Refetched with the list: another device may have used a model
          // since this screen loaded, and the section is meant to answer
          // "what was I using?" rather than "what did this tab see?".
          void refreshRecentModels();
        }}
        selectedModel={pickingPlanModel ? executionModel : selectedModel}
        recentModels={recentModels}
        onSelect={(id) => {
          // Choosing for a plan is choosing what Accept will run on, not
          // changing the conversation's model before anyone has accepted.
          if (pickingPlanModel) setPlanModelChoice({ callId: pickingPlanModel, model: id });
          else if (activeId) setRunModel(activeId, id);
          else setPendingModel(id);
        }}
        onOpenSettings={() => {
          setModelModalOpen(false);
          shell.openSettings();
        }}
      />
    </HStack>
  );
}
