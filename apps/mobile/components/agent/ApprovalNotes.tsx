import { Text } from '@/components/ui/text';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import type { PermissionBarView } from '@/lib/permissionBar';
import type { WaitDeadline } from '@/lib/pendingWaits';
import { clampLines } from '@/lib/truncate';

/**
 * "Agent wants to run `bash` — <summary>": the request in one sentence, the
 * same on the bar and in the sheet (#267). The bar adds a one-line summary
 * and clamps to two lines; the sheet lists the whole call under it instead.
 */
export function ApprovalRequestLine({
  tool,
  view,
  source,
  summary,
  testID,
}: {
  tool: string;
  view: PermissionBarView;
  source?: string;
  summary?: string;
  testID?: string;
}) {
  const { mcp } = view;
  return (
    <Text
      testID={testID}
      size="sm"
      className="text-foreground"
      numberOfLines={summary === undefined ? undefined : 2}
      style={summary === undefined ? undefined : clampLines(2)}
    >
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
      {summary === undefined ? null : (
        <>
          {' — '}
          <Text size="sm" className="font-mono text-muted-foreground">{summary}</Text>
        </>
      )}
    </Text>
  );
}

/**
 * What else a person should know before answering — the run's mode, why the
 * permission check asked, what "Allow always" records, when the request
 * stops waiting, and that answers need the server — the same on the bar and
 * in the sheet, under `<testIDBase>.mode` and so on.
 */
export function ApprovalNotes({
  view,
  offerAlways,
  deadline,
  testIDBase,
}: {
  view: PermissionBarView;
  offerAlways: boolean;
  deadline?: WaitDeadline;
  testIDBase: string;
}) {
  return (
    <>
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
    </>
  );
}
