import { useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { ShieldAlert } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ReviewSheet } from '@/components/agent/ReviewSheet';
import { ApprovalActions } from '@/components/agent/ApprovalActions';
import { ToolCallDetails } from '@/components/chat/ToolCallDetails';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { permissionBarView } from '@/lib/permissionBar';
import { useSession } from '@/lib/session';
import type { WaitDeadline } from '@/lib/pendingWaits';
import type { PermissionCheckNote, PermissionMode } from '@loxaic/api-client';

/** Chat's and routines' answers keep the ids they had as a modal. */
export const CHAT_APPROVAL_IDS = {
  deny: 'chat.approval.reject',
  allow: 'chat.approval.allowOnce',
  allowAlways: 'chat.approval.allowAlways',
  rule: 'chat.approval.rule',
};

interface ToolApprovalSheetProps {
  open: boolean;
  /** Absent where only an answer may end it — chat's request, which used to
   * be a modal for the same reason: it must not be tapped away by accident. */
  onClose?: () => void;
  /** `<base>.panel`, `<base>.body`, `<base>.arg.<key>`, and the notes. */
  testIDBase: string;
  /** The answers' ids, where they predate the sheet; `<base>.deny` and so on
   * otherwise. */
  ids?: { deny: string; allow: string; allowAlways: string; rule: string };
  denyLabel?: string;
  tool: string;
  args: Record<string, unknown>;
  /** Chat's: the assistant's own text alongside the call. Its system prompt
   * asks the model to say why. Absent shows no Reason at all. */
  reason?: string;
  /** Who is asking, when it is not the run on screen: a sub-agent. */
  source?: string;
  deadline?: WaitDeadline;
  /** From the approval itself — see `permissionBarView`. */
  mode?: PermissionMode;
  granterUserId?: string;
  selectorMode?: PermissionMode;
  rules?: string[];
  check?: PermissionCheckNote;
  onAllow: () => void;
  onAllowAlways?: () => void;
  onDeny: () => void;
}

/**
 * A permission request with everything the tool was given, in full (#267):
 * the agent bar's Details, and chat's request itself. The sheet fits a short
 * call and scrolls a long one, with the answers fixed under it. "Allow always"
 * is offered on the bar's terms (`permissionBarView`).
 */
export function ToolApprovalSheet({
  open,
  onClose,
  testIDBase,
  ids,
  denyLabel,
  tool,
  args,
  reason,
  source,
  deadline,
  mode,
  granterUserId,
  selectorMode,
  rules,
  check,
  onAllow,
  onAllowAlways,
  onDeny,
}: ToolApprovalSheetProps) {
  const { user } = useSession();
  const view = permissionBarView({ tool, mode, granterUserId, rules, check }, user?.id, selectorMode);
  const offerAlways = onAllowAlways !== undefined && view.canAllowAlways;
  // See PermissionBar: the request is what needs attention, and the keyboard
  // would cover the answers. Not on the web, where it would take focus from
  // someone typing.
  useEffect(() => {
    if (open && Platform.OS !== 'web') Keyboard.dismiss();
  }, [open]);
  // An explicit length check: a reason that trims to empty still falls back.
  const reasonText = reason?.trim();

  return (
    <ReviewSheet
      open={open}
      onClose={onClose}
      testIDBase={testIDBase}
      icon={ShieldAlert}
      eyebrow="Permission request"
      title={view.mcp ? `${view.mcp.server} · ${view.mcp.tool}` : tool}
      fit
      footer={
        <ApprovalActions
          view={view}
          onAllow={onAllow}
          onAllowAlways={onAllowAlways}
          onDeny={onDeny}
          denyLabel={denyLabel}
          ids={
            ids ?? {
              deny: `${testIDBase}.deny`,
              allow: `${testIDBase}.allow`,
              allowAlways: `${testIDBase}.allowAlways`,
              rule: `${testIDBase}.rule`,
            }
          }
        />
      }
    >
      <VStack space="md">
        {source ? (
          <Text testID={`${testIDBase}.source`} size="xs" className="font-medium text-warning">
            Sub-agent · {source}
          </Text>
        ) : null}
        {view.mcp ? (
          <Text size="sm" className="text-foreground">
            MCP server <Text size="sm" className="font-mono text-warning">{view.mcp.server}</Text> wants to run{' '}
            <Text size="sm" className="font-mono text-warning">{view.mcp.tool}</Text>
          </Text>
        ) : (
          <Text size="sm" className="text-foreground">
            {source ? 'It wants' : 'Agent wants'} to run <Text size="sm" className="font-mono text-warning">{tool}</Text>
          </Text>
        )}
        {reason !== undefined ? (
          <VStack space="xs">
            <Text size="2xs" className="uppercase text-muted-foreground">
              Reason
            </Text>
            <Text testID={`${testIDBase}.reason`} size="sm" className="text-foreground">
              {reasonText && reasonText.length > 0 ? reasonText : 'No reason given.'}
            </Text>
          </VStack>
        ) : null}
        <ToolCallDetails tool={tool} args={args} argTestID={(key) => `${testIDBase}.arg.${key}`} />
        {view.modeNote ? (
          <Text testID={`${testIDBase}.mode`} size="2xs" className="text-muted-foreground">
            {view.modeNote}
          </Text>
        ) : null}
        {view.checkNote ? (
          <Text testID={`${testIDBase}.checkNote`} size="xs" className="text-muted-foreground">
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
      </VStack>
    </ReviewSheet>
  );
}
