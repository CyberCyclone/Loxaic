import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MessagesSquare } from 'lucide-react-native';
import { findCommand } from '@loxaic/api-client';
import type { McpOverrides, ThinkingLevel } from '@loxaic/types';
import { disconnectedCopy, showsDisconnected, useConnection } from '@/lib/connection';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { ThreadList } from '@/components/chat/ThreadList';
import { MessageList } from '@/components/chat/MessageList';
import { PromptSuggestions } from '@/components/chat/PromptSuggestions';
import { ToolApprovalDialog } from '@/components/chat/ToolApprovalDialog';
import { StepCheckInBanner } from '@/components/chat/StepCheckInBanner';
import { Composer } from '@/components/composer/Composer';
import { ModelModal } from '@/components/settings/ModelModal';
import { useChatSession } from '@/hooks/useChatSession';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { pickSelectedModel } from '@/lib/selectModel';
import { useContextUsage } from '@/hooks/useContextUsage';
import { canEdit, isOwner } from '@/lib/types';
import { ShareModal } from '@/components/chat/ShareModal';
import { ConversationMenu } from '@/components/chat/ConversationMenu';
import { DeleteConversationModal } from '@/components/chat/DeleteConversationModal';
import { NoRoomModal } from '@/components/chat/NoRoomModal';
import { RewindModal } from '@/components/chat/RewindModal';
import { useRewindRetry, type ComposerSeed } from '@/hooks/useRewindRetry';
import { isServerConvId } from '@/lib/streamMessages';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSession } from '@/lib/session';
import { useThinkingChoice } from '@/hooks/useThinkingChoice';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToastHelper } from '@/hooks/useToastHelper';
import { useMcpSwitches } from '@/hooks/useMcpSwitches';
import { useContextStages } from '@/hooks/useContextStages';
import { ContextStageModal } from '@/components/context/ContextStageModal';
import { ContextSettingsSheet } from '@/components/context/ContextSettingsSheet';
import { formatWindow } from '@/lib/contextStages';

export default function ChatScreen() {
  const connection = useConnection();
  const shell = useShell();
  const { token, isAdmin } = useSession();
  const router = useRouter();
  const breakpoint = useBreakpoint();
  const pendingMcpRef = useRef<McpOverrides | undefined>(undefined);
  // The context stage chosen for a chat that does not exist yet; read by the
  // session at send time, like the MCP choices above.
  const pendingStageRef = useRef<number | undefined>(undefined);
  const thinkingRef = useRef<ThinkingLevel | undefined>(undefined);
  const {
    conversations,
    activeId,
    activeConv,
    setActiveId,
    streaming,
    stopping,
    loadingModel,
    promptStats,
    queuePosition,
    responseStartedAt,
    pendingApproval,
    pendingCheckin,
    handleSend,
    handleRetry,
    applyLocalRewind,
    handleStop,
    handleCommand,
    handleNewChat,
    handleApprove,
    handleDeny,
    handleSteps,
    handleAllowAlways,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
    history,
    noRoom,
    dismissNoRoom,
    returnedText,
    promotion,
    stageCard,
  } = useChatSession(token, () => { void refreshModels(); }, undefined, pendingMcpRef, pendingStageRef, thinkingRef);
  // Read by the session at send time; see useChatSession's `pendingMcp`.
  const mcp = useMcpSwitches(token, activeId, 'chat', promotion);
  pendingMcpRef.current = mcp.pendingOverrides;
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, getWindow, isKnown } =
    useModels(token);
  const { recentModels, refreshRecentModels, bumpRecentModel } = useRecentModels(token);
  const { showToast } = useToastHelper();

  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  // Puts an unsent message back in the message box (a no-room refusal).
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  // A send the server never heard of comes back to the message box.
  useEffect(() => { if (returnedText) setComposerSeed(returnedText); }, [returnedText]);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  // Both entry points — the header's ⋮ and the thread list's Delete — set
  // this, so there is one dialog and one wording of what deleting does here.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { config } = useServerConfig();

  const prefModel = activeConv?.model;
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

  const context = useContextUsage(activeConv?.msgs, selectedModel ? getWindow(selectedModel) : null);

  const readOnlyReason =
    activeConv && !canEdit(activeConv)
      ? 'This conversation is shared with you for viewing. You can read it as it happens, but not send.'
      : !showsDisconnected(connection)
        ? null
        : disconnectedCopy(connection).readOnly('conversation');

  // Rewind to a message, or answer the newest one again (#166): for someone
  // who can send here, while the server can be reached.
  const rewind = useRewindRetry({
    conversationId: activeId && isServerConvId(activeId) ? activeId : null,
    messages: activeConv?.msgs,
    enabled: readOnlyReason === null,
    retry: (restoreFiles) => {
      bumpRecentModel(selectedModel);
      return handleRetry(selectedModel, { restoreFiles });
    },
    applyLocalRewind,
    onSeed: setComposerSeed,
  });

  // A host model with YaRN stages: the approaching-the-limit and step-down
  // modals, Context settings, and the stage chosen before a chat exists.
  const stages = useContextStages({
    token,
    model: selectedModel || undefined,
    models,
    conversationId: activeId,
    context,
    streaming,
    readOnly: readOnlyReason !== null,
    isAdmin,
    onCompact: () => { handleRunCommand('compact', ''); },
    refreshModels: () => { void refreshModels(); },
    stageCard,
    promotion,
  });
  pendingStageRef.current = stages.pendingStage;

  // The dialog's "reason" is whatever the model said alongside this call —
  // no separate protocol field for it, just the assistant message that owns
  // the pending tool_call.
  const approvalReason = pendingApproval
    ? activeConv?.msgs.find((m) => m.tools?.some((t) => t.callId === pendingApproval.callId))?.text
    : undefined;

  const handleRunCommand = useCallback(
    (name: string, args: string) => {
      const cmd = findCommand(name);
      if (cmd?.requiresConversation && !activeId) {
        showToast('Start a conversation first');
        return;
      }
      handleCommand(name, args, selectedModel);
    },
    [activeId, selectedModel, handleCommand, showToast],
  );

  const threadList = (
    <ThreadList
      title="Chats"
      conversations={conversations}
      activeId={activeId}
      onSelect={(id) => {
        setActiveId(id);
        setThreadListOpen(false);
      }}
      onNewChat={() => {
        handleNewChat();
        setThreadListOpen(false);
      }}
      onFork={handleFork}
      onRename={handleRename}
      onDelete={(id) => { setDeletingId(id); }}
      onShare={(id) => { setSharingId(id); }}
    />
  );

  const deletingConv = conversations.find((c) => c.id === deletingId) ?? null;

  return (
    <HStack className="h-full flex-1">
      {breakpoint === 'wide' && threadList}

      <ShareModal
        open={!!sharingId}
        onClose={() => { setSharingId(null); }}
        conversationId={sharingId}
        title={conversations.find((c) => c.id === sharingId)?.title ?? ''}
      />

      <ContextStageModal stages={stages} />
      <ContextSettingsSheet stages={stages} />

      <RewindModal dialog={rewind.dialog} onConfirm={rewind.confirm} onCancel={rewind.cancel} />

      <NoRoomModal
        notice={noRoom}
        isAdmin={isAdmin}
        onClose={() => {
          if (noRoom?.text) setComposerSeed({ token: Date.now(), text: noRoom.text });
          dismissNoRoom();
        }}
        onChooseModel={() => { setModelModalOpen(true); }}
        onManage={() => { router.push('/host-models'); }}
      />

      <DeleteConversationModal
        title={deletingConv?.title ?? null}
        area="chat"
        retentionDays={config ? config.deletedChatRetentionDays : undefined}
        onCancel={() => { setDeletingId(null); }}
        onConfirm={() => {
          const id = deletingId;
          setDeletingId(null);
          if (id) void handleDelete(id);
        }}
      />

      <VStack className="h-full flex-1">
        <MainHeader
          title={activeConv?.title ?? 'Chat'}
          onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
          right={
            <HStack space="xs" className="items-center">
              {breakpoint !== 'wide' && (
                <Pressable
                  testID="chat.threadList.toggle"
                  onPress={() => { setThreadListOpen(true); }}
                  className="rounded-sm p-1.5 web:hover:bg-muted/50"
                >
                  <Icon as={MessagesSquare} size="sm" className="text-foreground" />
                </Pressable>
              )}
              {/* Owner-only, and only with a conversation to act on: its one
                  item is Delete, which the server refuses for anyone else. */}
              {activeConv && isOwner(activeConv) && (
                <ConversationMenu area="chat" onDelete={() => { setDeletingId(activeConv.id); }} />
              )}
            </HStack>
          }
        />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
        {activeConv ? (
          <MessageList
            conversation={activeConv}
            responseStartedAt={responseStartedAt}
            loadingModel={loadingModel}
            promptStats={promptStats}
            queuePosition={queuePosition}
            model={selectedModel ? getName(selectedModel) : undefined}
            history={history}
            stageCard={stageCard}
            actions={rewind.actions}
          />
        ) : (
          <PromptSuggestions
            onPick={(text) => {
              bumpRecentModel(selectedModel);
              handleSend(text, selectedModel);
            }}
          />
        )}
        {/* Above the composer, in the flow — not a dialog. Deciding whether
            the agent should carry on means reading what it has already done,
            so the transcript must stay visible and scrollable. */}
        {pendingCheckin && (
          <StepCheckInBanner
            {...pendingCheckin}
            onContinue={() => { handleSteps('continue'); }}
            onAnswer={() => { handleSteps('answer'); }}
            onStop={handleStop}
          />
        )}
        <Composer
          onSend={(text, attachments) => {
            // Reordered locally the moment the send happens, so reopening the
            // picker is already right rather than a turn behind. The server
            // records the same thing; the next fetch just confirms it.
            bumpRecentModel(selectedModel);
            handleSend(text, selectedModel, attachments);
          }}
          onStop={handleStop}
          stopping={stopping}
          streaming={streaming}
          modelName={selectedModel ? getName(selectedModel) : 'Select model'}
          context={context}
          onOpenModelModal={() => { setModelModalOpen(true); }}
          surface="chat"
          onRunCommand={handleRunCommand}
          commandSeed={composerSeed}
          mcp={mcp}
          thinking={thinking.composer}
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
        </KeyboardAvoidingView>
      </VStack>

      {breakpoint !== 'wide' && threadListOpen && (
        <>
          <Pressable onPress={() => { setThreadListOpen(false); }} className="absolute inset-0 bg-black/40" />
          <Box className="absolute bottom-0 right-0 top-0 shadow-lg">{threadList}</Box>
        </>
      )}

      {pendingApproval && (
        <ToolApprovalDialog
          tool={pendingApproval.tool}
          args={pendingApproval.args}
          deadline={pendingApproval.deadline}
          reason={approvalReason}
          onAllowOnce={() => { handleApprove(pendingApproval.callId); }}
          onAllowAlways={() => { void handleAllowAlways(pendingApproval.callId, pendingApproval.tool); }}
          onReject={() => { handleDeny(pendingApproval.callId); }}
        />
      )}

      <ModelModal
        open={modelModalOpen}
        onClose={() => { setModelModalOpen(false); }}
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
        selectedModel={selectedModel}
        recentModels={recentModels}
        onSelect={(id) => {
          if (activeId) setConversationModel(activeId, id);
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
