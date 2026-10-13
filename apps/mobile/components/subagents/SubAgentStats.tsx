import { displayModelRef } from '@loxaic/types';
import { ContextRing } from '@/components/composer/ContextRing';
import { LiveElapsed } from '@/components/chat/LiveElapsed';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import {
  formatDuration,
  subAgentContextPercent,
  subAgentCounterSince,
  subAgentDurationMs,
  subAgentRunState,
  subAgentSpeed,
  subAgentStatusLabel,
  type SubAgentView,
} from '@/lib/subAgents';

/** The dot beside the status: the run header's colours, plus a neutral one
 * for a sub-agent someone stopped — which is neither done nor an error. */
const DOT: Record<ReturnType<typeof subAgentRunState>, string> = {
  queued: 'bg-warning',
  running: 'bg-primary',
  awaiting_approval: 'bg-warning',
  done: 'bg-success',
  error: 'bg-destructive',
  stopped: 'bg-muted-foreground',
};

interface SubAgentStatsProps {
  view: SubAgentView;
  /** Whether Stop has been pressed and not yet seen to land. */
  stopping?: boolean;
  /** e.g. `subagent.card.<callId>` — each figure is `<base>.status`, `.model`,
   * `.context`, `.elapsed`, `.speed`. */
  testIDBase: string;
}

/**
 * Everything a sub-agent's card, its row in the list and its panel say about
 * how it is going: whether it is running, on which model, how full its
 * context is, for how long, and how fast.
 *
 * One component so the three cannot disagree. Every figure that is not known
 * is left out rather than shown as zero: a context ring at 0% and "0 tok/s"
 * would be claims, and before a child's first request has finished there is
 * nothing to claim.
 */
export function SubAgentStats({ view, stopping, testIDBase }: SubAgentStatsProps) {
  const state = subAgentRunState(view);
  const running = view.status === 'running';
  const percent = subAgentContextPercent(view);
  const speed = subAgentSpeed(view);
  const duration = subAgentDurationMs(view);
  // A send made before the model list had loaded names no model, and the
  // server then runs it on its default one. There is no name to show for
  // that, and an empty gap between two figures reads as a layout fault.
  const model = view.model && view.model !== 'default' ? displayModelRef(view.model) : '';
  return (
    // Wraps: on a phone the four figures do not fit one line, and a clipped
    // figure is worse than a second row.
    <HStack className="min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <HStack space="xs" className="shrink-0 items-center">
        <Box className={`h-1.5 w-1.5 rounded-full ${stopping && running ? 'bg-warning' : DOT[state]}`} />
        <Text testID={`${testIDBase}.status`} size="2xs" className="text-muted-foreground">
          {stopping && running ? 'Stopping…' : subAgentStatusLabel(view)}
        </Text>
      </HStack>
      {model && (
        <Text
          testID={`${testIDBase}.model`}
          size="2xs"
          className="min-w-0 shrink text-muted-foreground"
          numberOfLines={1}
          style={TRUNCATE_TEXT}
        >
          {model}
        </Text>
      )}
      {percent !== null && (
        <HStack space="xs" className="shrink-0 items-center">
          <ContextRing percent={percent} size={12} />
          <Text testID={`${testIDBase}.context`} size="2xs" className="text-muted-foreground">
            {`${String(percent)}% context`}
          </Text>
        </HStack>
      )}
      {running ? (
        <LiveElapsed testID={`${testIDBase}.elapsed`} since={subAgentCounterSince(view)} />
      ) : duration !== null ? (
        <Text testID={`${testIDBase}.elapsed`} size="2xs" className="shrink-0 text-muted-foreground">
          {formatDuration(duration)}
        </Text>
      ) : null}
      {speed && (
        <Text testID={`${testIDBase}.speed`} size="2xs" className="shrink-0 text-muted-foreground">
          {speed}
        </Text>
      )}
    </HStack>
  );
}
