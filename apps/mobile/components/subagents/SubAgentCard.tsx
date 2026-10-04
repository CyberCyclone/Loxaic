import { Bot, ChevronRight, Square } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useServerReachable } from '@/lib/connection';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { ToolCall } from '@/lib/types';
import type { SubAgentsUi } from './SubAgentContext';
import { SubAgentStats } from './SubAgentStats';

/**
 * A sub-agent, in its parent's transcript, where the call that started it is.
 *
 * Says whether it is running, on which model, how full its context is, for how
 * long and how fast; pressing it opens the panel with its own transcript; and
 * while it runs, Stop ends it and leaves its parent going.
 *
 * Deliberately not the child's report: that is the tool call's result, which
 * the parent's model reads and the panel shows. Repeating it here would put a
 * second agent's whole answer in the middle of the first one's thread.
 *
 * Three pressables side by side, not one wrapping the others: a Stop nested
 * inside the card's own press target would open the panel as it stopped.
 */
export function SubAgentCard({ tool, ui }: { tool: ToolCall; ui: SubAgentsUi }) {
  const reachable = useServerReachable();
  const callId = tool.callId ?? 'unknown';
  const view = ui.forCall(tool.callId, tool.subagent?.messageId);
  const description = view?.description ?? tool.subagent?.description ?? 'Sub-agent';
  const base = `subagent.card.${callId}`;

  // Not yet heard of on this thread's stream — the instant between the call
  // and the child starting, a refused call (which never starts one), or a
  // thread whose listing has not arrived. What the call's own result says is
  // all there is to say.
  if (!view) {
    const label = tool.result === '' ? 'Starting…' : tool.ok === true ? 'Finished' : 'Not run';
    return (
      <Box testID={base} className="my-1.5 rounded-md border border-border bg-card px-3 py-2.5">
        <HStack space="sm" className="min-w-0 items-center">
          <Icon as={Bot} size="sm" className="text-muted-foreground" />
          <VStack className="min-w-0 flex-1">
            <Text size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              {description}
            </Text>
            <Text testID={`${base}.status`} size="2xs" className="text-muted-foreground">
              {`Sub-agent · ${label}`}
            </Text>
          </VStack>
        </HStack>
      </Box>
    );
  }

  const running = view.status === 'running';
  const stopping = ui.isStopping(view.conversation_id);
  return (
    <Box testID={base} className="my-1.5 rounded-md border border-primary/30 bg-primary/5">
      <HStack className="min-w-0 items-stretch">
        <Pressable
          testID={`${base}.open`}
          accessibilityLabel={`Open sub-agent: ${description}`}
          onPress={() => { ui.open(view.conversation_id); }}
          className="min-w-0 flex-1 px-3 py-2.5 web:hover:bg-primary/5"
        >
          <HStack space="sm" className="min-w-0 items-start">
            <Box className="pt-0.5">
              <Icon as={Bot} size="sm" className="text-primary" />
            </Box>
            <VStack space="xs" className="min-w-0 flex-1">
              <Text size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {description}
              </Text>
              <SubAgentStats view={view} stopping={stopping} testIDBase={base} />
            </VStack>
          </HStack>
        </Pressable>
        {running && ui.canAct && (
          <Pressable
            testID={`${base}.stop`}
            accessibilityLabel={`Stop sub-agent: ${description}`}
            // Off while the stop is on its way, and while there is no server
            // to send it to — the gating rule every server-backed control here
            // follows.
            disabled={stopping || !reachable}
            onPress={() => { ui.stop(view.conversation_id); }}
            className={`shrink-0 items-center justify-center px-3 web:hover:bg-primary/10 ${stopping || !reachable ? 'opacity-40' : ''}`}
          >
            <Icon as={Square} size="sm" className="text-destructive" />
          </Pressable>
        )}
        <Pressable
          testID={`${base}.chevron`}
          accessibilityLabel="Open"
          onPress={() => { ui.open(view.conversation_id); }}
          className="shrink-0 items-center justify-center pl-1 pr-3 web:hover:bg-primary/10"
        >
          <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
        </Pressable>
      </HStack>
    </Box>
  );
}
