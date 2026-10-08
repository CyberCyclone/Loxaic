import { Box } from '@/components/ui/box';
import { Divider } from '@/components/ui/divider';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/ui/icon';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { ContextToolSource } from '@loxaic/types';
import type { ContextView } from '@/hooks/useContextUsage';
import type { McpSwitches } from '@/hooks/useMcpSwitches';
import type { StageControls } from '@/hooks/useContextStages';
import { toolSourceName, toolSourceRows, type ToolSourceRow } from '@/lib/toolSourceRows';
import { TRUNCATE_TEXT } from '@/lib/truncate';
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

function Note({ children, warn, testID }: { children: string; warn?: boolean; testID?: string }) {
  return (
    <Text testID={testID} size="2xs" className={warn ? 'text-destructive' : 'text-muted-foreground'}>
      {children}
    </Text>
  );
}

/**
 * Where the model's context stage is, and the way to change it without waiting
 * to be asked: the same choices as the "nearly full" modal, always reachable.
 * Shown only for a host model with YaRN stages.
 */
function StageRow({ stage }: { stage: StageControls }) {
  return (
    <VStack testID="context.stage" space="xs" className="rounded-md border border-border p-2">
      <HStack className="items-center justify-between">
        <Text size="xs" className="text-muted-foreground">Context stage</Text>
        <Text testID="context.stage.label" size="xs" className="text-foreground">{stage.label}</Text>
      </HStack>
      {stage.pendingLabel && (
        <VStack space="xs">
          <Text testID="context.stage.pending" size="2xs" className="text-warning">{stage.pendingLabel}</Text>
          {stage.mayChange && (
            <Pressable testID="context.stage.cancel" onPress={stage.onCancelPending} className="self-start">
              <Text size="2xs" className="text-foreground underline">Cancel switch</Text>
            </Pressable>
          )}
        </VStack>
      )}
      {stage.reason && <Note>{stage.reason}</Note>}
      <HStack space="sm" className="flex-wrap">
        {stage.canExtend && (
          <Pressable
            testID="context.stage.extend"
            onPress={stage.busy ? undefined : stage.onExtend}
            disabled={stage.busy}
            className={`rounded-md border border-border px-2 py-1 ${stage.busy ? 'opacity-40' : 'web:hover:bg-muted/50'}`}
          >
            <Text size="xs" className="font-medium text-foreground">Extend</Text>
          </Pressable>
        )}
        {stage.canSwitchBack && (
          <Pressable
            testID="context.stage.switchBack"
            onPress={stage.busy ? undefined : stage.onSwitchBack}
            disabled={stage.busy}
            className={`rounded-md border border-border px-2 py-1 ${stage.busy ? 'opacity-40' : 'web:hover:bg-muted/50'}`}
          >
            <Text size="xs" className="font-medium text-foreground">Switch back</Text>
          </Pressable>
        )}
        <Pressable testID="context.stage.settings" onPress={stage.onOpenSettings} className="rounded-md px-2 py-1 web:hover:bg-muted/50">
          <Text size="xs" className="text-muted-foreground underline">Context settings</Text>
        </Pressable>
      </HStack>
    </VStack>
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
  mcp = null,
  onCompact,
  busy,
  stage = null,
}: {
  context: ContextView;
  /** The model's YaRN stage and how to change it. Null for a model without. */
  stage?: StageControls | null;
  /** This conversation's MCP switches, shown beside each server's cost under
   * "Tool definitions". Null shows the costs alone. */
  mcp?: McpSwitches | null;
  /** Present only where there's an active conversation to compact — the
   * caller gates this the same way it gates rendering this popup at all. */
  onCompact?: () => void;
  /** Disables the button while a run is already in flight. */
  busy?: boolean;
}) {
  const { window, used, percent, segments, lastTurn } = context;
  const over = window != null && used > window;
  const [toolsOpen, setToolsOpen] = useState(false);

  // No resolvable window means no honest denominator. Say so rather than
  // rendering a percentage against a number we invented — but compaction
  // still works regardless of whether the window itself is known, so the
  // button stays available here too.
  if (window == null) {
    return (
      <VStack space="sm">
        <Note>Context window unknown for this model.</Note>
        {stage && <StageRow stage={stage} />}
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

      {stage && <StageRow stage={stage} />}

      {context.breakdownAvailable ? (
        <VStack space="xs">
          {segments.map((s) =>
            s.category === 'tools' ? (
              <VStack key={s.category} space="xs">
                {/* The one row that opens: which MCP server is costing what
                    is the question someone opens this popup to answer. */}
                <Pressable
                  testID="context.tools"
                  onPress={() => { setToolsOpen((o) => !o); }}
                  aria-expanded={toolsOpen}
                  className="flex-row items-center gap-1 rounded-sm web:hover:bg-muted/50"
                >
                  <Box className={`h-1.5 w-1.5 rounded-full ${SEGMENT_CLASS[s.category]}`} />
                  <Text size="xs" className="flex-1 text-muted-foreground">
                    {s.label}
                  </Text>
                  <Text size="xs" className="text-foreground">
                    {fmt(s.tokens)}
                  </Text>
                  <Icon as={toolsOpen ? ChevronDown : ChevronRight} size="2xs" className="text-muted-foreground" />
                </Pressable>
                {toolsOpen && <ToolSourceList sources={context.toolSources} mcp={mcp} />}
              </VStack>
            ) : (
              <HStack key={s.category} space="xs" className="items-center">
                <Box className={`h-1.5 w-1.5 rounded-full ${SEGMENT_CLASS[s.category]}`} />
                <Text size="xs" className="flex-1 text-muted-foreground">
                  {s.label}
                </Text>
                <Text size="xs" className="text-foreground">
                  {fmt(s.tokens)}
                </Text>
              </HStack>
            ),
          )}
        </VStack>
      ) : (
        <Note>Breakdown available after the next message.</Note>
      )}

      <VStack space="xs">
        {over && <Note warn>{`Over by ${fmt(used - window)} tokens — the next request compacts or extends the context first.`}</Note>}
        {context.maxWindow != null && context.maxWindow > window && (
          <Note>{`Loaded at ${fmt(window)} of ${fmt(context.maxWindow)} max.`}</Note>
        )}
        {context.windowSource === 'configured' ? (
          <Note testID="context.windowSource">Context size set by an admin — the provider doesn&apos;t report one.</Note>
        ) : context.windowSource === 'default' ? (
          // Compaction never acts on a guess, so this conversation can't be
          // compacted until an admin sets the model's size on its provider.
          <Note testID="context.windowSource" warn>
            Context size unknown — this conversation can&apos;t be compacted until an admin sets one for this model.
          </Note>
        ) : context.windowSource != null && context.windowSource !== 'loaded' ? (
          <Note testID="context.windowSource">Estimated from model max — actual window unknown.</Note>
        ) : null}
        {context.truncated && (
          // Only an older server says this: it replayed the newest 50–74
          // messages and dropped the rest. A current one drops nothing — a
          // full conversation is compacted or its context extended.
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

/** Each source's share of the tool schemas in the last request, with a switch
 * for each MCP server this conversation could be offered. */
function ToolSourceList({ sources, mcp }: { sources: ContextToolSource[] | null; mcp: McpSwitches | null }) {
  if (!sources) {
    return (
      <Box testID="context.toolSources.unknown" className="ml-3">
        <Note>Per-server figures from your next message.</Note>
      </Box>
    );
  }
  // Without switches there is nothing "now" to compare against, so the rows
  // are the last request's figures and nothing more.
  const rows: ToolSourceRow[] = mcp
    ? toolSourceRows(sources, mcp.rows)
    : sources.map((src) => ({ ...src, name: toolSourceName(src), on: null, switchable: false, note: null }));
  return (
    <VStack testID="context.toolSources" space="xs" className="ml-3 border-l border-border pl-2">
      {rows.map((row) => (
        <VStack key={row.key} testID={`context.toolSource.${row.key}`}>
          <HStack space="xs" className="min-w-0 items-center">
            <Text
              size="xs"
              className={`min-w-0 flex-1 ${row.on === false ? 'text-muted-foreground line-through' : 'text-foreground'}`}
              style={TRUNCATE_TEXT}
            >
              {row.name}
            </Text>
            <Text size="xs" className="shrink-0 text-muted-foreground">
              {row.tokens != null ? fmt(row.tokens) : '—'}
            </Text>
            {row.switchable && mcp ? (
              <Switch
                testID={`context.toolSource.${row.key}.toggle`}
                size="sm"
                value={row.on === true}
                disabled={!mcp.canToggle}
                onValueChange={(on) => { mcp.toggle(row.key, on); }}
              />
            ) : null}
          </HStack>
          {row.tools != null && row.note == null ? (
            <Text size="2xs" className="text-muted-foreground">{`${String(row.tools)} tools`}</Text>
          ) : null}
          {row.note ? <Note>{row.note}</Note> : null}
        </VStack>
      ))}
      {mcp?.lockedReason ? <Note>{mcp.lockedReason}</Note> : null}
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
      <Row testID="context.lastTurn.tokensIn" label="Tokens in" value={fmt(lastTurn.in)} />
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
