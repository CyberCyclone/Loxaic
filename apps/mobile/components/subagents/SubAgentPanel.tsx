import { useMemo } from 'react';
import { Bot, Square } from 'lucide-react-native';
import { PermissionBar } from '@/components/agent/PermissionBar';
import { ReviewSheet } from '@/components/agent/ReviewSheet';
import { MessageList } from '@/components/chat/MessageList';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { useServerReachable } from '@/lib/connection';
import type { SubAgentView } from '@/lib/subAgents';
import type { ChildTranscript } from '@/lib/subAgentTranscript';
import type { Conversation } from '@/lib/types';
import { SubAgentStats } from './SubAgentStats';

interface SubAgentPanelProps {
  /** The sub-agent shown, or null for closed. */
  view: SubAgentView | null;
  transcript: ChildTranscript | null;
  stopping: boolean;
  /** Whether this person may stop it or answer it — see SubAgentsUi. */
  canAct: boolean;
  onStop: () => void;
  onAllow: () => void;
  onDeny: () => void;
  onClose: () => void;
}

/**
 * A sub-agent, running: its own transcript in a bottom panel, drawn by the
 * same message list its parent's thread uses, streaming as it goes.
 *
 * Built on `ReviewSheet` for what that sheet already learnt on devices (its
 * height is set on a view inside; the keyboard is padded for by hand), with
 * its body left unscrolled — the list is a virtualised FlatList that scrolls
 * for itself and cannot sit inside a ScrollView.
 *
 * The approval is in the footer, as an inline bar, rather than a dialog over
 * the sheet: nothing in this app stacks a modal on a sheet, and iOS will not
 * present one while the other is up. While this panel is open the screen
 * behind it does not show the same question a second time.
 *
 * There is no composer: nobody talks to a sub-agent but the agent that started
 * it. What a person can do here is watch, stop it, and answer what it asks.
 */
export function SubAgentPanel({ view, transcript, stopping, canAct, onStop, onAllow, onDeny, onClose }: SubAgentPanelProps) {
  const reachable = useServerReachable();
  // The message list takes a conversation; a child is one, with no title or
  // model of its own worth showing beyond what the header already says.
  const conversation = useMemo<Conversation | null>(
    () =>
      view
        ? {
            id: view.conversation_id,
            title: view.description,
            kind: 'subagent',
            time: '',
            model: view.model,
            location: 'server',
            // Every user turn in a sub-agent's conversation was written by the
            // agent that started it (or by the server), never typed by a person.
            msgs: (transcript?.msgs ?? []).map((m) => (m.role === 'user' ? { ...m, fromAgent: true } : m)),
          }
        : null,
    [view, transcript?.msgs],
  );
  const running = view?.status === 'running';
  const live = transcript?.live ?? null;
  const approval = canAct ? view?.approval : undefined;
  // Nothing to show yet: the history has not answered and the stream has not
  // been heard from. Said, rather than left as an empty sheet.
  const waiting = !!view && (transcript?.msgs.length ?? 0) === 0 && !transcript?.historyLoaded;

  return (
    <ReviewSheet
      open={view !== null}
      onClose={onClose}
      testIDBase="subagent"
      icon={Bot}
      eyebrow="Sub-agent"
      title={view?.description ?? ''}
      scroll={false}
      headerActions={
        running && canAct ? (
          <Pressable
            testID="subagent.panel.stop"
            accessibilityLabel="Stop this sub-agent"
            disabled={stopping || !reachable}
            onPress={onStop}
            className={`flex-row items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1.5 web:hover:bg-destructive/10 ${stopping || !reachable ? 'opacity-40' : ''}`}
          >
            <Icon as={Square} size="xs" className="text-destructive" />
            <Text size="xs" className="font-medium text-destructive">
              {stopping ? 'Stopping…' : 'Stop'}
            </Text>
          </Pressable>
        ) : null
      }
      footer={
        approval ? (
          // Out to the sheet's edges, like the bar under a thread: the footer
          // box pads, and a tinted bar with a margin round it reads as a card.
          <Box className="-mx-4 -mb-4 -mt-3">
            <PermissionBar
              testIDBase="subagent.permission"
              tool={approval.tool}
              args={approval.args}
              deadline={approval.deadline}
              onAllow={onAllow}
              onDeny={onDeny}
            />
          </Box>
        ) : null
      }
    >
      {view && (
        <Box className="border-b border-border px-4 py-2">
          <SubAgentStats view={view} stopping={stopping} testIDBase="subagent.panel" />
          {view.status === 'error' && view.error ? (
            <Text testID="subagent.panel.error" size="2xs" className="mt-1 text-destructive">
              {view.error}
            </Text>
          ) : null}
          <DisconnectedNote testID="subagent.panel.reconnecting" />
        </Box>
      )}
      {waiting ? (
        <HStack space="sm" className="flex-1 items-center justify-center">
          <Spinner size="small" className="text-muted-foreground" />
          <Text testID="subagent.panel.loading" size="sm" className="text-muted-foreground">
            Loading its transcript…
          </Text>
        </HStack>
      ) : (
        <MessageList
          testID="subagent.panel.messageList"
          conversation={conversation}
          // The typing line under the transcript, while a request is out.
          responseStartedAt={running ? (live?.responseStartedAt ?? null) : null}
          loadingModel={live?.loadingModel ?? false}
          queuePosition={view?.state === 'queued' ? (view.queue_position ?? null) : null}
          model={live?.model ?? view?.model}
          promptStats={live?.promptStats ?? null}
        />
      )}
    </ReviewSheet>
  );
}
