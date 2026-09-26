import { TriangleAlert } from 'lucide-react-native';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';

interface WarningConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  testIDPrefix: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirmed action happens on this device only — changing the server
   * address, disconnecting from it — and so must stay possible while the
   * server cannot be reached; those are the way back. Everything else here
   * (delete, restore, reset a password) is a request, and waits for it. */
  local?: boolean;
}

/** A destructive-leaning confirm dialog for settings whose consequence isn't
 * obvious from the toggle itself — host mode's loss of isolation, letting a
 * sandbox reach the network. Used instead of the inline-retry pattern the MCP
 * SSRF guard uses because these changes affect every user on the deployment,
 * not just the person making them. */
export function WarningConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  testIDPrefix,
  onConfirm,
  onCancel,
  local = false,
}: WarningConfirmModalProps) {
  const reachable = useServerReachable();
  const blocked = !local && !reachable;
  return (
    <Modal isOpen={open} onClose={onCancel} size="sm">
      <ModalBackdrop />
      <ModalContent testID={`${testIDPrefix}.dialog`}>
        <ModalHeader>
          <HStack space="sm" className="items-center">
            <Icon as={TriangleAlert} size="sm" className="text-destructive" />
            <Heading size="sm">{title}</Heading>
          </HStack>
        </ModalHeader>
        <ModalBody>
          <VStack space="sm">
            <Text size="sm" className="text-foreground">
              {message}
            </Text>
            {!local && <DisconnectedNote testID={`${testIDPrefix}.disconnected`} what="do this" />}
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end">
          <HStack space="sm">
            <Button testID={`${testIDPrefix}.cancel`} variant="outline" size="sm" onPress={onCancel}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID={`${testIDPrefix}.confirm`}
              size="sm"
              className="bg-destructive"
              isDisabled={blocked}
              onPress={onConfirm}
            >
              <ButtonText className="text-destructive-foreground">{confirmLabel}</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
