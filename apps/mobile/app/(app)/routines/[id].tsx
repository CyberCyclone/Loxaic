import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MessagesSquare, Play } from 'lucide-react-native';
import { findCommand, getRoutineConversations, getRoutines, isUnreachableError, runRoutineNow, type Routine } from '@loxaic/api-client';
import { describeRequestError, disconnectedCopy, showsDisconnected, useConnection } from '@/lib/connection';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { ThreadList } from '@/components/chat/ThreadList';
import { MessageList } from '@/components/chat/MessageList';
import { ToolApprovalDialog } from '@/components/chat/ToolApprovalDialog';
import { StepCheckInBanner } from '@/components/chat/StepCheckInBanner';
import { DeleteConversationModal } from '@/components/chat/DeleteConversationModal';
import { NoRoomModal } from '@/components/chat/NoRoomModal';
import { Composer } from '@/components/composer/Composer';
import { useChatSession, toConversation, type ChatScope } from '@/hooks/useChatSession';
import { useModels } from '@/hooks/useModels';
import { useContextUsage } from '@/hooks/useContextUsage';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSession } from '@/lib/session';
import { useToastHelper } from '@/hooks/useToastHelper';
import { useMcpSwitches } from '@/hooks/useMcpSwitches';
import { useSubAgents } from '@/hooks/useSubAgents';
import { ConversationMenu } from '@/components/chat/ConversationMenu';
import { SubAgentContext } from '@/components/subagents/SubAgentContext';
import { SubAgentPanel } from '@/components/subagents/SubAgentPanel';
import { SubAgentsList } from '@/components/subagents/SubAgentsList';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { humanizeCron } from '@/lib/fixtures/routines';
import { runStatusIsError, runStatusLabel, runTimeLabel } from '@/lib/routineRuns';
import type { Conversation } from '@/lib/types';

/**
 * One routine's chats — #179.
 *
 * Opening a routine lands on its last run, with the ordinary composer to carry
 * the conversation on from there, and the messages icon opens a history list
 * holding this routine's chats and no others. Everything below the surface is
 * the Chat screen's own machinery, reached through `useChatSession`'s scope
 * parameter: one socket, one set of streaming, approval and check-in handling.
 *
 * What this screen does *not* offer is as deliberate as what it does. There is
 * no model picker — the routine's model is the only one its chats ever use,
 * and it is chosen in one place, the routine's own form. There is no new-chat
 * button: a routine's chats exist because its runs created them, so the same
 * corner offers Run now instead.
 */
export default function RoutineChatScreen() {
  const connection = useConnection();
  const router = useRouter();
  const { token, isAdmin } = useSession();
  const breakpoint = useBreakpoint();
  const { showToast } = useToastHelper();
  const { config } = useServerConfig();
  const { getName, getWindow, isKnown } = useModels(token);

  const params = useLocalSearchParams<{ id: string; c?: string; history?: string }>();
  const routineId = params.id;

  const [routine, setRoutine] = useState<Routine | null>(null);
  const [routineLoaded, setRoutineLoaded] = useState(false);
  /** The routine could not be asked about — not the same as it being gone,
   * which is what this screen used to say whenever the server was
   * unreachable. Asked again once the server answers. */
  const [routineUnknown, setRoutineUnknown] = useState(false);
  const [routineAttempt, setRoutineAttempt] = useState(0);
  const reachable = connection === 'online';
  useEffect(() => {
    if (reachable && routineUnknown) setRoutineAttempt((n) => n + 1);
  }, [reachable, routineUnknown]);
  const [threadListOpen, setThreadListOpen] = useState(params.history === '1');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** Each run's status and start time, by conversation id — every chat this
   * routine makes carries the same title, so this is what tells the rows
   * apart. */
  // `Partial<Record<…>>` rather than `Record<…>`: a lookup really can miss —
  // a conversation added optimistically, or one whose run row the list has
  // not caught up with — and the plain form lies about that.
  const [runMeta, setRunMeta] = useState<Partial<Record<string, { status: string; startedAt: string }>>>({});

  // There is no single-routine route, and adding one to answer "what is this
  // called" is not worth a round trip the list already makes.
  useEffect(() => {
    let cancelled = false;
    if (!token) return;
    getRoutines()
      .then((rows) => {
        if (cancelled) return;
        setRoutine(rows.find((r) => r.id === routineId) ?? null);
        setRoutineUnknown(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRoutineUnknown(isUnreachableError(err));
      })
      .finally(() => {
        if (!cancelled) setRoutineLoaded(true);
      });
    return () => { cancelled = true; };
  }, [token, routineId, routineAttempt]);

  /**
   * This session is over one routine's chats.
   *
   * Recreated only when the routine changes — the hook reads it through a ref,
   * so a new object on every render would be harmless, but a stable one keeps
   * that obvious rather than incidental.
   */
  const scope = useMemo<ChatScope>(
    () => ({
      list: async () => {
        const rows = await getRoutineConversations(routineId);
        // Kept beside the list rather than folded into `Conversation`: the run
        // is a fact about this screen's rows, not about a conversation.
        setRunMeta(
          Object.fromEntries(rows.map((r) => [r.id, { status: r.run.status, startedAt: r.run.startedAt }])),
        );
        return rows.map(toConversation);
      },
      kind: 'routine',
      // A routine's chats come from its runs. Sending with nothing open would
      // open an ordinary chat conversation from this screen.
      allowCreate: false,
      // Deliberately not cached: these would take eviction slots from the
      // user's own threads, and the Chat surface's list write prunes anything
      // it does not recognise.
      cache: false,
      initialActiveId: params.c ?? null,
    }),
    [routineId, params.c],
  );

  const {
    conversations,
    listLoaded,
    refreshList,
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
    handleStop,
    handleCommand,
    handleApprove,
    handleDeny,
    handleSteps,
    handleAllowAlways,
    rememberAlwaysAllow,
    handleDelete,
    history,
    noRoom,
    dismissNoRoom,
    subAgents: subAgentState,
  } = useChatSession(token, undefined, scope);
  // A routine's run may hand work to sub-agents, like the agent's — see
  // agent.tsx. A routine's chats belong to their owner alone, so whoever is
  // looking at one may stop its sub-agents and answer them.
  const subAgents = useSubAgents(subAgentState, activeConv?.id ?? null, activeConv !== null);
  const childApproval = pendingApproval ? null : subAgents.approvalChild;
  // The approval here is a dialog, and nothing in this app puts a dialog over
  // a sheet (iOS will not present one while the other is up, or still
  // leaving). So a sheet gives way to the run's own approval, and the dialog
  // waits until the sheet has gone.
  const sheetOpen = subAgents.listOpen || subAgents.panel.view !== null;
  const [sheetGone, setSheetGone] = useState(true);
  const closeSubAgentPanel = subAgents.panel.close;
  const closeSubAgentList = subAgents.closeList;
  useEffect(() => {
    if (pendingApproval && sheetOpen) {
      closeSubAgentPanel();
      closeSubAgentList();
    }
  }, [pendingApproval, sheetOpen, closeSubAgentPanel, closeSubAgentList]);
  useEffect(() => {
    if (sheetOpen) {
      setSheetGone(false);
      return;
    }
    const timer = setTimeout(() => { setSheetGone(true); }, 300);
    return () => { clearTimeout(timer); };
  }, [sheetOpen]);
  // A routine's chats exist only because a run made them, so there is never
  // a first send to carry choices on: every switch here is a PATCH.
  const mcp = useMcpSwitches(token, activeConv?.id ?? null, 'routine');
  // Puts an unsent message back in the message box (a no-room refusal).
  const [composerSeed, setComposerSeed] = useState<{ token: number; text: string } | null>(null);

  // The routine's model, and only it: the server serves every send in one of
  // these conversations on the routine's model whatever the client names, so
  // offering a picker here would be a control that does nothing.
  const model = routine?.model ?? activeConv?.model ?? '';
  const modelName = model ? (isKnown(model) ? getName(model) : model) : 'No model';
  const context = useContextUsage(activeConv?.msgs, model ? getWindow(model) : null);

  /** The schedule in words, or null when `humanizeCron` had none to give and
   * handed back the raw expression. */
  const schedule = (() => {
    if (!routine) return null;
    const human = humanizeCron(routine.cron);
    return human === routine.cron ? null : human;
  })();

  const approvalReason = pendingApproval
    ? activeConv?.msgs.find((m) => m.tools?.some((t) => t.callId === pendingApproval.callId))?.text
    : undefined;

  const startRun = useCallback(async () => {
    setStarting(true);
    try {
      const run = await runRoutineNow(routineId);
      await refreshList();
      // The server answers non-2xx when no run was created, so this should
      // always hold — but an older server said `200 {ok: true}` for that, and
      // `setActiveId(undefined)` then blanked a screen `refreshList` had just
      // filled, showing "hasn't run yet" over a full history with nothing
      // saying the run never started.
      if (!run.conversationId) {
        showToast('The run could not be started. Try again.', 4000);
        return;
      }
      // Straight into the run that was just started — that is what pressing
      // it meant.
      setActiveId(run.conversationId);
      setThreadListOpen(false);
    } catch (err) {
      showToast(`Could not run: ${describeRequestError(err, 'something went wrong')}`, 4000);
    } finally {
      setStarting(false);
    }
  }, [routineId, refreshList, setActiveId, showToast]);

  const handleRunCommand = useCallback(
    (name: string, args: string) => {
      const cmd = findCommand(name);
      // `/compact` earns its place here: a routine that runs every hour and is
      // then talked to builds exactly the long conversation it is for.
      if (cmd?.requiresConversation && !activeId) {
        showToast('Run this routine first — there is no chat to act on yet');
        return;
      }
      handleCommand(name, args, model);
    },
    [activeId, model, handleCommand, showToast],
  );

  const rowMeta = useCallback(
    (c: Conversation) => {
      const meta = runMeta[c.id];
      if (!meta) return null;
      // Every chat here is named after the routine, which is also this
      // panel's heading — so the run itself is what distinguishes one row
      // from the next, and it leads.
      return {
        title: `Run · ${runTimeLabel(meta.startedAt)}`,
        badge: runStatusLabel(meta.status),
        danger: runStatusIsError(meta.status),
        time: '',
      };
    },
    [runMeta],
  );

  const threadList = (
    <ThreadList
      title={routine?.name ?? 'Routine'}
      conversations={conversations}
      activeId={activeId}
      onSelect={(id) => {
        setActiveId(id);
        setThreadListOpen(false);
      }}
      newAction={{
        icon: Play,
        testID: 'threadList.runNow',
        label: 'Run now',
        disabled: starting || !reachable,
        onPress: () => { void startRun(); },
      }}
      // No fork and no rename: a forked run belongs to no routine, and these
      // chats are named after the routine rather than by their owner.
      onDelete={(id) => { setDeletingId(id); }}
      rowMeta={rowMeta}
    />
  );

  const deletingConv = conversations.find((c) => c.id === deletingId) ?? null;

  if (routineLoaded && !routine && !routineUnknown) {
    return (
      <VStack className="h-full flex-1">
        <MainHeader
          title="Routine"
          onBack={() => { router.replace('/routines'); }}
          backTestID="routineChat.back"
        />
        <Box testID="routineChat.notFound" className="flex-1 items-center justify-center p-6">
          <Text className="mb-2 text-center text-foreground">This routine is gone</Text>
          <Text size="sm" className="mb-4 text-center text-muted-foreground">
            It was deleted, along with its chats.
          </Text>
          <Button size="sm" className="bg-primary" onPress={() => { router.replace('/routines'); }}>
            <ButtonText className="text-primary-foreground">Back to routines</ButtonText>
          </Button>
        </Box>
      </VStack>
    );
  }

  return (
    <HStack className="h-full flex-1">
      {breakpoint === 'wide' && threadList}

      {/* No "choose a model": a routine's chats run on the routine's model. */}
      <NoRoomModal
        notice={noRoom}
        isAdmin={isAdmin}
        onClose={() => {
          if (noRoom?.text) setComposerSeed({ token: Date.now(), text: noRoom.text });
          dismissNoRoom();
        }}
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
          title={routine?.name ?? 'Routine'}
          subtitle={routine ? [schedule, modelName].filter(Boolean).join(' · ') : undefined}
          // Back rather than the sidebar menu: this screen was arrived at from
          // the routines list, and going back there is what the issue asks for
          // ("go back to the routines list, and select that routine").
          onBack={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/routines');
          }}
          backTestID="routineChat.back"
          right={
            <HStack space="xs" className="items-center">
              {breakpoint !== 'wide' && (
                <Pressable
                  testID="routineChat.threadList.toggle"
                  onPress={() => { setThreadListOpen(true); }}
                  className="rounded-sm p-1.5 web:hover:bg-muted/50"
                >
                  <Icon as={MessagesSquare} size="sm" className="text-foreground" />
                </Pressable>
              )}
              {/* The ⋮ here holds one thing: this chat's sub-agents. Deleting
                  a routine's chat stays where it was, in its history list. */}
              {activeConv && (
                <ConversationMenu
                  area="routineChat"
                  subAgents={{ open: subAgents.openList, running: subAgents.running }}
                />
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
            <SubAgentContext.Provider value={subAgents.ui}>
              <MessageList
                conversation={activeConv}
                responseStartedAt={responseStartedAt}
                loadingModel={loadingModel}
                promptStats={promptStats}
                queuePosition={queuePosition}
                model={model ? modelName : undefined}
                history={history}
              />
            </SubAgentContext.Provider>
          ) : !listLoaded ? (
            <Box className="flex-1 items-center justify-center">
              <Spinner />
            </Box>
          ) : (
            // Never run. There is no conversation to show and none to create
            // by typing, so the only thing on offer is the thing that makes
            // one.
            <Box testID="routineChat.empty" className="flex-1 items-center justify-center p-6">
              <Text className="mb-2 text-center text-foreground">This routine hasn&apos;t run yet</Text>
              <Text size="sm" className="mb-4 text-center text-muted-foreground">
                {/* `humanizeCron` returns the raw expression for anything it
                    does not recognise, and "It runs 0 4 1 1 *" is worse than
                    not mentioning the schedule at all — so the sentence is
                    only offered when there is a human one to offer. */}
                {schedule ? `Its schedule is ${schedule}. ` : ''}
                Each run starts its own chat, which you can read and carry on here.
              </Text>
              <Button
                testID="routineChat.empty.runNow"
                size="sm"
                className="bg-primary"
                isDisabled={starting || !reachable}
                onPress={() => { void startRun(); }}
              >
                <ButtonIcon as={Play} className="text-primary-foreground" />
                <ButtonText className="text-primary-foreground">Run now</ButtonText>
              </Button>
            </Box>
          )}
          {pendingCheckin && (
            <StepCheckInBanner
              {...pendingCheckin}
              onContinue={() => { handleSteps('continue'); }}
              onAnswer={() => { handleSteps('answer'); }}
              onStop={handleStop}
            />
          )}
          {activeConv && (
            <Composer
              onSend={(text, attachments) => { handleSend(text, model, attachments); }}
              onStop={handleStop}
              stopping={stopping}
              streaming={streaming}
              modelName={modelName}
              context={context}
              // No picker: this conversation runs on the routine's model, and
              // the server enforces that regardless of what a client sends.
              // Changing it is done once, in the routine's own form.
              onOpenModelModal={() => {
                showToast('This chat runs on the routine’s model — change it by editing the routine');
              }}
              surface="chat"
              onRunCommand={handleRunCommand}
              commandSeed={composerSeed}
              mcp={mcp}
              readOnlyReason={
                !showsDisconnected(connection)
                  ? null
                  : disconnectedCopy(connection).readOnly('conversation')
              }
            />
          )}
        </KeyboardAvoidingView>
      </VStack>

      {breakpoint !== 'wide' && threadListOpen && (
        <>
          <Pressable onPress={() => { setThreadListOpen(false); }} className="absolute inset-0 bg-black/40" />
          <Box className="absolute bottom-0 right-0 top-0 shadow-lg">{threadList}</Box>
        </>
      )}

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

      {pendingApproval && sheetGone && (
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
      {/* A sub-agent's request, in the same dialog the run's own uses, saying
          which sub-agent is asking. Not while its panel is open — the question
          is in the panel's footer then — and not over the list. */}
      {childApproval?.approval && sheetGone && !sheetOpen && (
        <ToolApprovalDialog
          tool={childApproval.approval.tool}
          args={childApproval.approval.args}
          deadline={childApproval.approval.deadline}
          source={childApproval.description}
          reason={`Sub-agent task: ${childApproval.description}`}
          onAllowOnce={() => { subAgents.answer(childApproval.conversation_id, true); }}
          onAllowAlways={() => {
            const tool = childApproval.approval?.tool;
            if (!tool) return;
            void rememberAlwaysAllow(tool).then(() => { subAgents.answer(childApproval.conversation_id, true); });
          }}
          onReject={() => { subAgents.answer(childApproval.conversation_id, false); }}
        />
      )}
    </HStack>
  );
}
