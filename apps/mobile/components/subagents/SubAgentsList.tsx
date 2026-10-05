import { Bot, ChevronRight } from 'lucide-react-native';
import { ReviewSheet } from '@/components/agent/ReviewSheet';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { useServerReachable } from '@/lib/connection';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { SubAgentView } from '@/lib/subAgents';
import { SubAgentStats } from './SubAgentStats';

interface SubAgentsListProps {
  open: boolean;
  /** Running first, then finished — `listedSubAgents`. */
  subAgents: SubAgentView[];
  /** The stored listing could not be fetched, so what is shown may be missing
   * the sub-agents of earlier runs. */
  unavailable?: boolean;
  onRetry?: () => void;
  isStopping: (childConvId: string) => boolean;
  onOpen: (childConvId: string) => void;
  onClose: () => void;
}

/**
 * This thread's sub-agents, from the ⋮ menu: the ones running now, then the
 * ones that have finished. Choosing one opens the same panel its card does.
 *
 * Finished ones are listed too, on purpose: a sub-agent's card scrolls away
 * with the conversation, and this is the other way back to what it did.
 */
export function SubAgentsList({ open, subAgents, unavailable = false, onRetry, isStopping, onOpen, onClose }: SubAgentsListProps) {
  const reachable = useServerReachable();
  const running = subAgents.filter((s) => s.status === 'running');
  const finished = subAgents.filter((s) => s.status !== 'running');
  return (
    <ReviewSheet
      open={open}
      onClose={onClose}
      testIDBase="subagent.list"
      icon={Bot}
      eyebrow="This thread"
      title="Sub-agents"
    >
      {unavailable && (
        // "Could not ask" is not "none": said in the list's own place, with
        // the way to ask again.
        <VStack space="xs" className="mb-3 rounded-md border border-border bg-card px-3 py-2.5">
          <Text testID="subagent.list.unavailable" size="sm" className="text-foreground">
            Couldn't load this thread's earlier sub-agents
          </Text>
          <Text size="xs" className="text-muted-foreground">
            Your server didn't answer. Any that ran before you opened this thread are missing from this list.
          </Text>
          <Button
            testID="subagent.list.retry"
            variant="outline"
            size="sm"
            isDisabled={!reachable}
            onPress={onRetry}
            className="mt-1 self-start"
          >
            <ButtonText>Try again</ButtonText>
          </Button>
        </VStack>
      )}
      {subAgents.length === 0 ? (
        unavailable ? null : (
        <VStack space="xs" className="items-center py-10">
          <Text testID="subagent.list.empty" size="sm" className="text-center text-foreground">
            No sub-agents yet
          </Text>
          <Text size="xs" className="text-center text-muted-foreground">
            When the agent hands part of its work to a sub-agent, it appears here while it runs and after it finishes.
          </Text>
        </VStack>
        )
      ) : (
        <VStack space="lg">
          <Section title="Running" testID="subagent.list.running" items={running} empty="None running right now." isStopping={isStopping} onOpen={onOpen} />
          {finished.length > 0 && (
            <Section title="Finished" testID="subagent.list.finished" items={finished} isStopping={isStopping} onOpen={onOpen} />
          )}
        </VStack>
      )}
    </ReviewSheet>
  );
}

function Section({
  title,
  testID,
  items,
  empty,
  isStopping,
  onOpen,
}: {
  title: string;
  testID: string;
  items: SubAgentView[];
  empty?: string;
  isStopping: (childConvId: string) => boolean;
  onOpen: (childConvId: string) => void;
}) {
  return (
    <VStack testID={testID} space="sm">
      <Text size="2xs" className="uppercase text-muted-foreground">
        {`${title} · ${String(items.length)}`}
      </Text>
      {items.length === 0 && empty ? (
        <Text size="xs" className="text-muted-foreground">
          {empty}
        </Text>
      ) : null}
      {items.map((view) => (
        <Pressable
          key={view.conversation_id}
          testID={`subagent.list.${view.conversation_id}`}
          accessibilityLabel={`Open sub-agent: ${view.description}`}
          onPress={() => { onOpen(view.conversation_id); }}
          className="rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/50"
        >
          <HStack space="sm" className="min-w-0 items-center">
            <Icon as={Bot} size="sm" className={view.status === 'running' ? 'text-primary' : 'text-muted-foreground'} />
            <VStack space="xs" className="min-w-0 flex-1">
              <Text size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {view.description}
              </Text>
              <SubAgentStats view={view} stopping={isStopping(view.conversation_id)} testIDBase={`subagent.list.${view.conversation_id}`} />
            </VStack>
            <Box className="shrink-0">
              <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
            </Box>
          </HStack>
        </Pressable>
      ))}
    </VStack>
  );
}
