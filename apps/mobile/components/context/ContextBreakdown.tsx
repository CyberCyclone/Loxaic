import { Box } from '@/components/ui/box';
import { Divider } from '@/components/ui/divider';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import type { ContextView } from '@/hooks/useContextUsage';
import { promptReuse } from '@/lib/usage';
import { ContextBar } from './ContextBar';
import { SEGMENT_CLASS } from './segments';

const fmt = (n: number) => n.toLocaleString();

function Row({
  label,
  value,
  muted,
  testID,
}: {
  label: string;
  value: string;
  muted?: boolean;
  testID?: string;
}) {
  return (
    <HStack className="items-center justify-between">
      <Text size="xs" className="text-muted-foreground">
        {label}
      </Text>
      <Text testID={testID} size="xs" className={muted ? 'text-muted-foreground' : 'text-foreground'}>
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

function CompactButton({ onPress, busy }: { onPress: () => void; busy?: boolean }) {
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      disabled={busy}
      className={`items-center rounded-md border border-border px-3 py-1.5 ${busy ? 'opacity-40' : 'web:hover:bg-muted/50'}`}
    >
      <Text size="xs" className="font-medium text-foreground">
        Compact
      </Text>
    </Pressable>
  );
}

/**
 * What is actually consuming the context window, and how fast the last turn
 * ran. Rows minus free space always equal the last turn's in + out, so the
 * numbers can be checked against each other on sight.
 */
export function ContextBreakdown({
  context,
  onCompact,
  busy,
}: {
  context: ContextView;
  /** Present only where there's an active conversation to compact — the
   * caller gates this the same way it gates rendering this popup at all. */
  onCompact?: () => void;
  /** Disables the button while a run is already in flight. */
  busy?: boolean;
}) {
  const { window, used, percent, segments, lastTurn } = context;
  const over = window != null && used > window;

  // No resolvable window means no honest denominator. Say so rather than
  // rendering a percentage against a number we invented — but compaction
  // still works regardless of whether the window itself is known, so the
  // button stays available here too.
  if (window == null) {
    return (
      <VStack space="sm">
        <Note>Context window unknown for this model.</Note>
        {onCompact && <CompactButton onPress={onCompact} busy={busy} />}
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
          // historyMessages, not historyLimit: the limit stopped being the
          // window size when the replay was anchored — it is a floor now, and
          // the window grows to HISTORY_LIMIT + HISTORY_STEP - 1 before
          // re-anchoring. Reporting the floor would claim "last 50" on a
          // conversation that actually replayed 74.
          <Note>{`Showing last ${String(context.historyMessages)} messages; older turns already dropped.`}</Note>
        )}
      </VStack>

      {onCompact && <CompactButton onPress={onCompact} busy={busy} />}

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
  const reuse = promptReuse(lastTurn);
  return (
    <VStack space="xs">
      <Text size="2xs" className="uppercase text-muted-foreground">
        Last turn
      </Text>
      <Row label="Tokens in" value={fmt(lastTurn.in)} />
      <Row label="Tokens out" value={fmt(lastTurn.out)} />
      {reuse && (
        // "Cached" is the backend's own count and proves a hit; "reused" is
        // our measurement of how much of this prompt repeated the previous
        // one, which is all that's knowable on a backend (LM Studio) that
        // reports no cache figures at all. Never conflate the two labels.
        <Row
          testID="context.lastTurn.reuse"
          label={reuse.measured ? 'Prompt cached' : 'Prompt reused'}
          value={`${String(reuse.pct)}%`}
        />
      )}
      {lastTurn.promptTps != null ? (
        <Row testID="context.lastTurn.promptRate" label="Prompt speed" value={`${String(Math.round(lastTurn.promptTps))} tok/s`} />
      ) : lastTurn.ttftMs != null ? (
        // No honest rate available — the backend didn't say how many prompt
        // tokens it actually evaluated. Show what it cost instead.
        <Row testID="context.lastTurn.promptCost" label="Prompt eval" value={`${(lastTurn.ttftMs / 1000).toFixed(2)}s`} />
      ) : null}
      {lastTurn.genTps != null && <Row label="Generation speed" value={`${String(Math.round(lastTurn.genTps))} tok/s`} />}
      {lastTurn.totalMs != null && <Row label="Duration" value={`${(lastTurn.totalMs / 1000).toFixed(1)}s`} />}
    </VStack>
  );
}
