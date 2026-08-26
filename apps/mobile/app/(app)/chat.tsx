import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { MessagesSquare, Terminal } from 'lucide-react-native';
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
import { Composer } from '@/components/composer/Composer';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { RawIoPanel } from '@/components/debug/RawIoPanel';
import { ModelModal } from '@/components/settings/ModelModal';
import { useChatSession } from '@/hooks/useChatSession';
import { useModels } from '@/hooks/useModels';
import { useContextUsage } from '@/hooks/useContextUsage';
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
    handleSend,
    handleStop,
    handleCommand,
    handleNewChat,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
    debugEntries,
    debugActive,
    openDebug,
    closeDebug,
    clearDebug,
  } = useChatSession(token, () => refreshModels());
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, getWindow, isKnown } =
    useModels(token);
  const { showToast } = useToastHelper();

  const [settings] = useSettings();
  const [thinkingLevels, setThinkingLevels] = useThinkingLevels();
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [pendingIncognito, setPendingIncognito] = useState(false);

  // Incognito is fixed once a conversation exists server-side; the toggle only
  // applies to a not-yet-started chat.
  const incognito = activeConv ? !!activeConv.incognito : pendingIncognito;
  const incognitoLocked = !!activeConv;

  const thinkingLevel = (activeId && thinkingLevels[activeId]) || settings.defaultThinkingLevel;

  const prefModel = activeConv?.model;
  const selectedModel =
    (prefModel && (models.length === 0 || isKnown(prefModel)) ? prefModel : null) ??
    pendingModel ??
    defaultModel?.id ??
    '';

  const context = useContextUsage(activeConv?.msgs, selectedModel ? getWindow(selectedModel) : null);

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
        setPendingIncognito(false);
        setThreadListOpen(false);
      }}
      onNewChat={() => {
        handleNewChat();
        setPendingIncognito(false);
        setThreadListOpen(false);
      }}
      onFork={handleFork}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );

  return (
    <HStack className="h-full flex-1">
      {breakpoint === 'wide' && threadList}

      <VStack className="h-full flex-1">
        <MainHeader
          title={activeConv?.title ?? 'Chat'}
          subtitle={activeConv?.incognito ? 'Incognito · not saved' : undefined}
          onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
          right={
            <HStack space="sm" className="items-center">
              {!!settings.devMode && (
                <Pressable
                  onPress={debugActive ? closeDebug : openDebug}
                  className={`rounded-sm p-1.5 web:hover:bg-muted/50 ${debugActive ? 'bg-primary/15' : ''}`}
                >
                  <Icon as={Terminal} size="sm" className={debugActive ? 'text-primary' : 'text-foreground'} />
                </Pressable>
              )}
              {breakpoint !== 'wide' && (
                <Pressable onPress={() => setThreadListOpen(true)} className="rounded-sm p-1.5 web:hover:bg-muted/50">
                  <Icon as={MessagesSquare} size="sm" className="text-foreground" />
                </Pressable>
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
            model={selectedModel ? getName(selectedModel) : undefined}
          />
        ) : (
          <PromptSuggestions onPick={(text) => handleSend(text, selectedModel, incognito)} />
        )}
        <Composer
          onSend={(text) => handleSend(text, selectedModel, incognito)}
          onStop={handleStop}
          streaming={streaming}
          modelName={selectedModel ? getName(selectedModel) : 'Select model'}
          context={context}
          onOpenModelModal={() => setModelModalOpen(true)}
          incognito={incognito}
          onToggleIncognito={() => setPendingIncognito((v) => !v)}
          incognitoLocked={incognitoLocked}
          surface="chat"
          onRunCommand={handleRunCommand}
        />
        </KeyboardAvoidingView>
      </VStack>

      {breakpoint === 'wide' && (
        <RawIoPanel open={debugActive} onClose={closeDebug} wide entries={debugEntries} onClear={clearDebug} />
      )}

      {breakpoint !== 'wide' && threadListOpen && (
        <>
          <Pressable onPress={() => setThreadListOpen(false)} className="absolute inset-0 bg-black/40" />
          <Box className="absolute bottom-0 right-0 top-0 shadow-lg">{threadList}</Box>
        </>
      )}

      {breakpoint !== 'wide' && (
        <RawIoPanel open={debugActive} onClose={closeDebug} wide={false} entries={debugEntries} onClear={clearDebug} />
      )}

      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
      <ModelModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={refreshModels}
        selectedModel={selectedModel}
        onSelect={(id) => (activeId ? setConversationModel(activeId, id) : setPendingModel(id))}
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
