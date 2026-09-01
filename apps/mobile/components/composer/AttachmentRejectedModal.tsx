import { ShieldAlert } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalHeader } from '@/components/ui/modal';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

export interface AttachmentRejection {
  /** The file the user picked, for a message that names it. */
  filename: string;
  /** Why it couldn't be accepted, from the server where possible. */
  reason: string;
}

interface AttachmentRejectedModalProps {
  rejection: AttachmentRejection | null;
  onClose: () => void;
}

/**
 * Explains why a document was refused rather than silently dropped.
 *
 * PDFs and Office files are only ever parsed inside a container sandbox — the
 * parsers are baked into the sandbox image and never run in the server
 * process. With no container available there is nowhere safe to read one, so
 * the upload is rejected outright rather than stored as a file the model can
 * never see.
 *
 * A modal rather than a toast because this is a refusal the user needs to
 * understand and act on (attach a text file, or get sandboxing enabled), not
 * a transient status they can miss while looking elsewhere.
 */
export function AttachmentRejectedModal({ rejection, onClose }: AttachmentRejectedModalProps) {
  return (
    <Modal isOpen={!!rejection} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="attachment.rejected.modal">
        <ModalHeader>
          <HStack space="sm" className="items-center">
            <Icon as={ShieldAlert} size="sm" className="text-destructive" />
            <Text className="font-medium text-foreground">Can&apos;t attach this file</Text>
          </HStack>
        </ModalHeader>
        <ModalBody>
          <VStack space="sm">
            <Text className="text-foreground">
              <Text className="font-medium text-foreground">{rejection?.filename}</Text> wasn&apos;t
              uploaded.
            </Text>
            <Text size="sm" className="text-muted-foreground">
              {rejection?.reason}
            </Text>
            <Text size="sm" className="text-muted-foreground">
              Text, Markdown, CSV, JSON and source files don&apos;t need a sandbox and still work.
            </Text>
          </VStack>
        </ModalBody>
        <HStack className="justify-end p-4">
          <Button testID="attachment.rejected.dismiss" onPress={onClose} size="sm">
            <ButtonText>OK</ButtonText>
          </Button>
        </HStack>
      </ModalContent>
    </Modal>
  );
}
