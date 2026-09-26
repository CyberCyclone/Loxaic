import { Pin } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { unsentNote, type NoRoomNotice } from '@/lib/noRoom';

/** Long enough for this modal's exit animation to finish. iOS will not
 * present the model list while this is still being dismissed (the plan sheet
 * found the same), so the list opens after it, never on top of it. */
const MODAL_EXIT_MS = 300;

interface NoRoomModalProps {
  notice: NoRoomNotice | null;
  /** Admins can unpin; everyone else is told to ask one. */
  isAdmin: boolean;
  onClose: () => void;
  /** Opens the model picker, where loaded models are marked — called once
   * this modal has gone. Absent where the model cannot be changed (a
   * routine's chat). */
  onChooseModel?: () => void;
  /** Opens Host models, for an admin. Called after `onClose`. */
  onManage: () => void;
}

/**
 * A host model could not be loaded because pinned models hold the GPU memory
 * it needs (apps/server/src/llama/room.ts). A modal rather than a toast: the
 * message was not sent, the fix is someone else's (an admin unpinning), and
 * the way round it — a model that is already loaded — is a choice to make now.
 * The server's own sentence names the model and the pinned ones.
 */
export function NoRoomModal({ notice, isAdmin, onClose, onChooseModel, onManage }: NoRoomModalProps) {
  return (
    <Modal isOpen={notice !== null} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="chat.noRoom" className="max-h-[85%]">
        <ModalHeader>
          <HStack space="sm" className="min-w-0 shrink items-center">
            <Icon as={Pin} size="sm" className="shrink-0 text-warning" />
            <Heading size="sm" className="min-w-0 shrink">
              No room to load this model
            </Heading>
          </HStack>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="sm">
            <Text testID="chat.noRoom.message" size="sm" className="text-foreground">
              {notice?.message ?? ''}
            </Text>
            {notice && unsentNote(notice) !== null && (
              <Text testID="chat.noRoom.unsent" size="xs" className="text-muted-foreground">
                {unsentNote(notice)}
              </Text>
            )}
            {isAdmin && (
              <Text size="xs" className="text-muted-foreground">
                You are an admin: unpin a model under Host models to make room.
              </Text>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end">
          <HStack space="sm" className="flex-wrap justify-end">
            {isAdmin && (
              <Button
                testID="chat.noRoom.manage"
                variant="outline"
                size="sm"
                onPress={() => {
                  onClose();
                  onManage();
                }}
              >
                <ButtonText>Host models</ButtonText>
              </Button>
            )}
            {onChooseModel && (
              <Button
                testID="chat.noRoom.choose"
                variant="outline"
                size="sm"
                onPress={() => {
                  onClose();
                  setTimeout(onChooseModel, MODAL_EXIT_MS);
                }}
              >
                <ButtonText>Choose a loaded model</ButtonText>
              </Button>
            )}
            <Button testID="chat.noRoom.close" size="sm" onPress={onClose}>
              <ButtonText>OK</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
