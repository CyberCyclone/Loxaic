import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { ApprovalActions } from '@/components/agent/ApprovalActions';
import { ToolApprovalSheet } from '@/components/agent/ToolApprovalSheet';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import type { WaitDeadline } from '@/lib/pendingWaits';
import { permissionBarView } from '@/lib/permissionBar';
import { useSession } from '@/lib/session';
import { toolSummary } from '@/lib/streamMessages';
import { clampLines } from '@/lib/truncate';
import type { PermissionCheckNote, PermissionMode } from '@loxaic/api-client';

interface PermissionBarProps {
  tool: string;
  args: Record<string, unknown>;
  deadline?: WaitDeadline;
  /** The asking run's mode and the user whose "Allow always" the server
   * records, both from the approval itself — see `permissionBarView`. */
  mode?: PermissionMode;
  granterUserId?: string;
  /** The selector, so the bar can say when the run is in another mode. */
  selectorMode?: PermissionMode;
  /** For `bash`: the command rules "Allow always" records, and why auto
   * mode's permission check asked — both from the approval itself. */
  rules?: string[];
  check?: PermissionCheckNote;
  onAllow: () => void;
  /** Approves this call and stops the tool asking (#266). Offered only when
   * given, and only to the person it would be recorded for. */
  onAllowAlways?: () => void;
  onDeny: () => void;
  /**
   * Who is asking, when it is not the run on screen: a sub-agent's
   * description. Shown above the request, so a prompt that appears under the
   * parent's thread says which agent wants to run the tool.
   */
  source?: string;
  /** `agent.permission` unless a second bar can be on screen with it — the
   * one inside a sub-agent's panel. */
  testIDBase?: string;
  /** Offer the Details sheet (#267). Not where the bar is itself a sheet's
   * footer — sheets never stack; the call's card above it expands instead. */
  detailsSheet?: boolean;
}

export function PermissionBar({
  tool,
  args,
  deadline,
  mode,
  granterUserId,
  selectorMode,
  rules,
  check,
  onAllow,
  onAllowAlways,
  onDeny,
  source,
  testIDBase = 'agent.permission',
  detailsSheet = true,
}: PermissionBarProps) {
  const { user } = useSession();
  const view = permissionBarView({ tool, mode, granterUserId, rules, check }, user?.id, selectorMode);
  const { mcp } = view;
  const offerAlways = onAllowAlways !== undefined && view.canAllowAlways;
  // The bar is keyed by the question, so this starts closed for each new one.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // One line of what the call does, two at most; the whole of it is a tap
  // away in the Details sheet (#267).
  const summary = toolSummary(tool, args);
  // On a phone the keyboard leaves about a hundred points between the header
  // and the composer, and the bar's buttons were cut off below it: a run
  // parked on a question nobody could reach the answer to. The prompt is what
  // needs attention, so the keyboard goes; whatever was typed stays. Not on the
  // web, where this would take focus from someone typing ahead at a desk.
  useEffect(() => {
    if (Platform.OS !== 'web') Keyboard.dismiss();
  }, []);
  const answer = (fn: () => void) => () => {
    setDetailsOpen(false);
    fn();
  };
  return (
    <VStack
      testID={`${testIDBase}.bar`}
      space="xs"
      className="border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      {source ? (
        <Text testID={`${testIDBase}.source`} size="xs" className="font-medium text-warning">
          Sub-agent · {source}
        </Text>
      ) : null}
      <Text testID={`${testIDBase}.summary`} size="sm" className="text-foreground" numberOfLines={2} style={clampLines(2)}>
        {mcp ? (
          <>
            MCP server <Text size="sm" className="font-mono text-warning">{mcp.server}</Text> wants to run{' '}
            <Text size="sm" className="font-mono text-warning">{mcp.tool}</Text>
          </>
        ) : (
          <>
            {source ? 'It wants' : 'Agent wants'} to run <Text size="sm" className="font-mono text-warning">{tool}</Text>
          </>
        )}
        {summary === '{}' ? null : (
          <>
            {' — '}
            <Text size="sm" className="font-mono text-muted-foreground">{summary}</Text>
          </>
        )}
      </Text>
      {view.modeNote ? (
        <Text testID={`${testIDBase}.mode`} size="2xs" className="text-muted-foreground">
          {view.modeNote}
        </Text>
      ) : null}
      {view.checkNote ? (
        <Text testID={`${testIDBase}.checkNote`} size="2xs" className="text-muted-foreground">
          {view.checkNote}
        </Text>
      ) : null}
      {offerAlways && view.note ? (
        <Text testID={`${testIDBase}.alwaysNote`} size="2xs" className="text-muted-foreground">
          {view.note}
        </Text>
      ) : null}
      <DeadlineCountdown kind="approval" deadline={deadline} testID={`${testIDBase}.deadline`} />
      <DisconnectedNote testID={`${testIDBase}.reconnecting`} />
      <ApprovalActions
        view={view}
        onAllow={onAllow}
        onAllowAlways={onAllowAlways}
        onDeny={onDeny}
        ids={{
          deny: `${testIDBase}.deny`,
          allow: `${testIDBase}.allow`,
          allowAlways: `${testIDBase}.allowAlways`,
          rule: `${testIDBase}.rule`,
        }}
        leading={
          detailsSheet ? (
            // Reading, not answering: stays enabled offline.
            <Button
              testID={`${testIDBase}.details`}
              variant="link"
              size="sm"
              className="mr-auto"
              onPress={() => { setDetailsOpen(true); }}
            >
              <ButtonText>Details</ButtonText>
            </Button>
          ) : null
        }
      />
      {detailsSheet ? (
        <ToolApprovalSheet
          open={detailsOpen}
          onClose={() => { setDetailsOpen(false); }}
          testIDBase={`${testIDBase}.sheet`}
          tool={tool}
          args={args}
          source={source}
          deadline={deadline}
          mode={mode}
          selectorMode={selectorMode}
          granterUserId={granterUserId}
          rules={rules}
          check={check}
          onAllow={answer(onAllow)}
          onAllowAlways={onAllowAlways ? answer(onAllowAlways) : undefined}
          onDeny={answer(onDeny)}
        />
      ) : null}
    </VStack>
  );
}
