import { ScrollView } from 'react-native';
import { Modal, ModalBackdrop, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { splitMcpTool } from '@/components/chat/ToolCallCard';
import type { WaitDeadline } from '@/lib/pendingWaits';
import { DeadlineCountdown } from './DeadlineCountdown';

interface ToolApprovalDialogProps {
  tool: string;
  args: Record<string, unknown>;
  /** The assistant's own text alongside this call, if it said anything before
   * calling the tool. Chat's system prompt asks the model to state why. */
  reason?: string;
  /** When the request stops waiting — the call then does not run. */
  deadline?: WaitDeadline;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onReject: () => void;
}

/** A tool-call approval, blocking until the user decides — unlike the
 * agent surface's inline PermissionBar, chat presents this as a modal so it
 * can't be missed or scrolled past, and always offers "allow always" (an MCP
 * tool patches its server's policy; a builtin patches the user's global
 * allowlist — see useChatSession's handleAllowAlways). No backdrop-dismiss:
 * a pending tool call needs an explicit decision, not an accidental tap-away. */
export function ToolApprovalDialog({ tool, args, reason, deadline, onAllowOnce, onAllowAlways, onReject }: ToolApprovalDialogProps) {
  const mcp = splitMcpTool(tool);
  const pretty = JSON.stringify(args, null, 2);
  // Explicit length check rather than `??`: a reason that trims to empty must
  // still fall back, which nullish-coalescing would let through as blank.
  const reasonText = reason?.trim();
  const reasonLabel = reasonText && reasonText.length > 0 ? reasonText : 'No reason given.';

  return (
    <Modal isOpen onClose={() => undefined} size="md">
      <ModalBackdrop />
      <ModalContent testID="chat.approval.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="md">Tool call wants to run</Heading>
        </ModalHeader>
        <ModalBody>
          <VStack space="md">
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
            <DeadlineCountdown kind="approval" deadline={deadline} testID="chat.approval.deadline" />
          </VStack>
        </ModalBody>
        <ModalFooter className="flex-wrap justify-end gap-2 border-t border-border">
          <Button testID="chat.approval.reject" variant="outline" size="sm" onPress={onReject}>
            <ButtonText>Reject</ButtonText>
          </Button>
          <Button testID="chat.approval.allowAlways" variant="outline" size="sm" onPress={onAllowAlways}>
            <ButtonText>Allow always</ButtonText>
          </Button>
          <Button testID="chat.approval.allowOnce" size="sm" onPress={onAllowOnce}>
            <ButtonText>Allow once</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
