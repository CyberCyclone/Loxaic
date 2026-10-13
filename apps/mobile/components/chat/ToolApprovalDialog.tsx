import { ScrollView } from 'react-native';
import { Modal, ModalBackdrop, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { splitMcpTool } from '@/components/chat/ToolCallCard';
import { permissionBarView } from '@/lib/permissionBar';
import { useSession } from '@/lib/session';
import type { PermissionCheckNote, PermissionMode } from '@loxaic/api-client';
import type { WaitDeadline } from '@/lib/pendingWaits';
import { useServerReachable } from '@/lib/connection';
import { DeadlineCountdown } from './DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';

interface ToolApprovalDialogProps {
  tool: string;
  args: Record<string, unknown>;
  /** The assistant's own text alongside this call, if it said anything before
   * calling the tool. Chat's system prompt asks the model to state why. */
  reason?: string;
  /** When the request stops waiting — the call then does not run. */
  deadline?: WaitDeadline;
  /** From the approval itself, as on the agent's bar — see permissionBarView:
   * who "Allow always" is recorded for, what it records for `bash`, and why
   * auto mode's permission check asked. */
  mode?: PermissionMode;
  granterUserId?: string;
  rules?: string[];
  check?: PermissionCheckNote;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onReject: () => void;
  /** Who is asking, when it is not the run on screen: a sub-agent's
   * description — see PermissionBar's `source`. */
  source?: string;
}

/** A tool-call approval, blocking until the user decides — unlike the
 * agent surface's inline PermissionBar, chat presents this as a modal so it
 * can't be missed or scrolled past. "Allow always" is offered on the same
 * terms as the bar (permissionBarView): only to the person it is recorded
 * for, and for `bash` only with the command rules the server proposed. No
 * backdrop-dismiss: a pending tool call needs an explicit decision, not an
 * accidental tap-away. */
export function ToolApprovalDialog({
  tool,
  args,
  reason,
  deadline,
  mode,
  granterUserId,
  rules,
  check,
  onAllowOnce,
  onAllowAlways,
  onReject,
  source,
}: ToolApprovalDialogProps) {
  const mcp = splitMcpTool(tool);
  const { user } = useSession();
  const view = permissionBarView({ tool, mode, granterUserId, rules, check }, user?.id);
  const pretty = JSON.stringify(args, null, 2);
  // Explicit length check rather than `??`: a reason that trims to empty must
  // still fall back, which nullish-coalescing would let through as blank.
  const reasonText = reason?.trim();
  const reasonLabel = reasonText && reasonText.length > 0 ? reasonText : 'No reason given.';
  // An answer needs an open socket; until then it could only be dropped (#231).
  const disconnected = !useServerReachable();

  return (
    <Modal isOpen onClose={() => undefined} size="md">
      <ModalBackdrop />
      <ModalContent testID="chat.approval.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="md">Tool call wants to run</Heading>
        </ModalHeader>
        {/* Both halves, as everywhere else: the vendored ModalBody hardcodes
            `scrollEnabled={false}`, so with only the height cap a long reason
            pushes the countdown below a fold nothing can scroll to. */}
        <ModalBody scrollEnabled>
          <VStack space="md">
            {source ? (
              <Text testID="chat.approval.source" size="xs" className="font-medium text-warning">
                Sub-agent · {source}
              </Text>
            ) : null}
            <HStack space="xs" className="flex-wrap items-baseline">
              {mcp ? (
                <>
                  <Text size="sm" className="text-muted-foreground">MCP server</Text>
                  <Text size="sm" className="font-mono font-semibold text-foreground">{mcp.server}</Text>
                  <Text size="sm" className="text-muted-foreground">·</Text>
                  <Text size="sm" className="font-mono font-semibold text-foreground">{mcp.tool}</Text>
                </>
              ) : (
                <Text size="sm" className="font-mono font-semibold text-foreground">{tool}</Text>
              )}
            </HStack>
            <VStack space="xs">
              <Text size="xs" className="uppercase text-muted-foreground">Reason</Text>
              <Text size="sm" className="text-foreground">{reasonLabel}</Text>
            </VStack>
            <VStack space="xs">
              <Text size="xs" className="uppercase text-muted-foreground">Call</Text>
              <ScrollView style={{ maxHeight: 160 }} className="rounded-md border border-border bg-muted">
                <Text
                  className="p-3 leading-[18px] text-muted-foreground"
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                >
                  {pretty}
                </Text>
              </ScrollView>
            </VStack>
            {view.checkNote ? (
              <Text testID="chat.approval.checkNote" size="xs" className="text-muted-foreground">
                {view.checkNote}
              </Text>
            ) : null}
            <DeadlineCountdown kind="approval" deadline={deadline} testID="chat.approval.deadline" />
            <DisconnectedNote testID="chat.approval.reconnecting" />
          </VStack>
        </ModalBody>
        <ModalFooter className="flex-wrap justify-end gap-2 border-t border-border">
          <Button testID="chat.approval.reject" variant="outline" size="sm" onPress={onReject} isDisabled={disconnected}>
            <ButtonText>Reject</ButtonText>
          </Button>
          {view.canAllowAlways ? (
            <Button testID="chat.approval.allowAlways" variant="outline" size="sm" onPress={onAllowAlways} isDisabled={disconnected}>
              <ButtonText testID="chat.approval.rule">{view.alwaysLabel ?? 'Allow always'}</ButtonText>
            </Button>
          ) : null}
          <Button testID="chat.approval.allowOnce" size="sm" onPress={onAllowOnce} isDisabled={disconnected}>
            <ButtonText>Allow once</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
