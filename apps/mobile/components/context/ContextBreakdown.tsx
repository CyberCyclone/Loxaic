import { Box } from '@/components/ui/box';
import { Divider } from '@/components/ui/divider';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { ContextView } from '@/hooks/useContextUsage';
import { ContextBar } from './ContextBar';
import { SEGMENT_CLASS } from './segments';

const fmt = (n: number) => n.toLocaleString();

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <HStack className="items-center justify-between">
      <Text size="xs" className="text-muted-foreground">
        {label}
      </Text>
      <Text size="xs" className={muted ? 'text-muted-foreground' : 'text-foreground'}>
        {value}
      </Text>
    </HStack>
  );
}

function Note({ children, warn }: { children: string; warn?: boolean }) {
  return (
    <Text size="2xs" className={warn ? 'text-destructive' : 'text-muted-foreground'}>
      {children}
    </Text>
  );
}

/**
 * What is actually consuming the context window, and how fast the last turn
 * ran. Rows minus free space always equal the last turn's in + out, so the
 * numbers can be checked against each other on sight.
 */
export function ContextBreakdown({ context }: { context: ContextView }) {
  const { window, used, percent, segments, lastTurn } = context;
  const over = window != null && used > window;

  // No resolvable window means no honest denominator. Say so rather than
  // rendering a percentage against a number we invented.
  if (window == null) {
    return (
      <VStack space="xs">
        <Note>Context window unknown for this model.</Note>
        {lastTurn && <LastTurnRows lastTurn={lastTurn} />}
      </VStack>
    );
  }

  return (
    <VStack space="sm">
      <VStack space="xs">
        <HStack className="items-baseline justify-between">
          <Text size="xs" className="text-foreground">
            {fmt(used)} <Text size="xs" className="text-muted-foreground">/ {fmt(window)}</Text>
          </Text>
          <Text size="xs" className={over ? 'font-medium text-destructive' : 'text-muted-foreground'}>
            {percent}%
          </Text>
        </HStack>
        <ContextBar segments={segments} over={over} />
      </VStack>

      {context.breakdownAvailable ? (
        <VStack space="xs">
          {segments.map((s) => (
            <HStack key={s.category} space="xs" className="items-center">
              <Box className={`h-1.5 w-1.5 rounded-full ${SEGMENT_CLASS[s.category]}`} />
              <Text size="xs" className="flex-1 text-muted-foreground">
                {s.label}
              </Text>
              <Text size="xs" className="text-foreground">
                {fmt(s.tokens)}
              </Text>
            </HStack>
          ))}
        </VStack>
      ) : (
        <Note>Breakdown available after the next message.</Note>
      )}

      <VStack space="xs">
        {over && <Note warn>{`Over by ${fmt(used - window)} tokens — oldest turns will be dropped.`}</Note>}
        {context.maxWindow != null && context.maxWindow > window && (
          <Note>{`Loaded at ${fmt(window)} of ${fmt(context.maxWindow)} max.`}</Note>
        )}
        {context.windowSource != null && context.windowSource !== 'loaded' && (
          <Note>Estimated from model max — actual window unknown.</Note>
        )}
        {context.truncated && (
          <Note>{`Showing last ${context.historyLimit} messages; older turns already dropped.`}</Note>
        )}
      </VStack>

      {lastTurn && (
        <>
          <Divider className="bg-border" />
          <LastTurnRows lastTurn={lastTurn} />
        </>
      )}
    </VStack>
  );
}

function LastTurnRows({ lastTurn }: { lastTurn: NonNullable<ContextView['lastTurn']> }) {
  return (
    <VStack space="xs">
      <Text size="2xs" className="uppercase text-muted-foreground">
        Last turn
      </Text>
      <Row label="Tokens in" value={fmt(lastTurn.in)} />
      <Row label="Tokens out" value={fmt(lastTurn.out)} />
      {lastTurn.promptTps != null && <Row label="Prompt speed" value={`${Math.round(lastTurn.promptTps)} tok/s`} />}
      {lastTurn.genTps != null && <Row label="Generation speed" value={`${Math.round(lastTurn.genTps)} tok/s`} />}
      {lastTurn.totalMs != null && <Row label="Duration" value={`${(lastTurn.totalMs / 1000).toFixed(1)}s`} />}
    </VStack>
  );
}
