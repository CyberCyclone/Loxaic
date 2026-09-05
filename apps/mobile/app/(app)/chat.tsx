import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { MessagesSquare } from 'lucide-react-native';
import { findCommand } from '@shannon/api-client';
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
import { Composer } from '@/components/composer/Composer';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ModelModal } from '@/components/settings/ModelModal';
import { useChatSession } from '@/hooks/useChatSession';
import { useModels } from '@/hooks/useModels';
import { useContextUsage } from '@/hooks/useContextUsage';
import { canEdit } from '@/lib/types';
import { ShareModal } from '@/components/chat/ShareModal';
import { useSession } from '@/lib/session';
import { useThinkingLevels, useSettings } from '@/hooks/useSettings';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToastHelper } from '@/hooks/useToastHelper';

export default function ChatScreen() {
  const shell = useShell();
  const { token } = useSession();
  const breakpoint = useBreakpoint();
  const {
    conversations,
    activeId,
    activeConv,
    setActiveId,
    streaming,
    loadingModel,
    responseStartedAt,
    pendingApproval,
    handleSend,
    handleStop,
    handleCommand,
    handleNewChat,
    handleApprove,
    handleDeny,
    handleAllowAlways,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
  } = useChatSession(token, () => { void refreshModels(); });
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, getWindow, isKnown } =
    useModels(token);
  const { showToast } = useToastHelper();

  const [settings] = useSettings();
  const [thinkingLevels, setThinkingLevels] = useThinkingLevels();
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);

  const thinkingLevelsById: Partial<Record<string, typeof settings.defaultThinkingLevel>> = thinkingLevels;
  const storedThinkingLevel = activeId ? thinkingLevelsById[activeId] : undefined;
  const thinkingLevel = storedThinkingLevel ?? settings.defaultThinkingLevel;

  const prefModel = activeConv?.model;
  const selectedModel =
    (prefModel && (models.length === 0 || isKnown(prefModel)) ? prefModel : null) ??
    pendingModel ??
    defaultModel?.id ??
    '';

  const context = useContextUsage(activeConv?.msgs, selectedModel ? getWindow(selectedModel) : null);

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
      onDelete={handleDelete}
      onShare={(id) => { setSharingId(id); }}
    />
  );

  return (
    <HStack className="h-full flex-1">
      {breakpoint === 'wide' && threadList}

      <ShareModal
        open={!!sharingId}
        onClose={() => { setSharingId(null); }}
        conversationId={sharingId}
        title={conversations.find((c) => c.id === sharingId)?.title ?? ''}
      />

      <VStack className="h-full flex-1">
        <MainHeader
          title={activeConv?.title ?? 'Chat'}
          onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
          right={
            breakpoint !== 'wide' ? (
              <Pressable
                testID="chat.threadList.toggle"
                onPress={() => { setThreadListOpen(true); }}
                className="rounded-sm p-1.5 web:hover:bg-muted/50"
              >
                <Icon as={MessagesSquare} size="sm" className="text-foreground" />
              </Pressable>
            ) : undefined
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
            model={selectedModel ? getName(selectedModel) : undefined}
          />
        ) : (
          <PromptSuggestions onPick={(text) => { handleSend(text, selectedModel); }} />
        )}
        <Composer
          onSend={(text, attachments) => { handleSend(text, selectedModel, attachments); }}
          onStop={handleStop}
          streaming={streaming}
          modelName={selectedModel ? getName(selectedModel) : 'Select model'}
          context={context}
          onOpenModelModal={() => { setModelModalOpen(true); }}
          surface="chat"
          onRunCommand={handleRunCommand}
          readOnlyReason={
            activeConv && !canEdit(activeConv)
              ? 'This conversation is shared with you for viewing. You can read it as it happens, but not send.'
              : null
          }
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
          reason={approvalReason}
          onAllowOnce={() => { handleApprove(pendingApproval.callId); }}
          onAllowAlways={() => { void handleAllowAlways(pendingApproval.callId, pendingApproval.tool); }}
          onReject={() => { handleDeny(pendingApproval.callId); }}
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
          if (activeId) setConversationModel(activeId, id);
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
