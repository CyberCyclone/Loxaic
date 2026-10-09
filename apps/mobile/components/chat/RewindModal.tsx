import { Undo2 } from 'lucide-react-native';
import type { RewindPreview, RewindScope } from '@loxaic/api-client';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { FILE_LIMITS, filesMessage, rewindMessage } from '@/lib/rewind';

/** What the dialog is asking about. `preview` is null while it loads. */
export type RewindDialog =
  | { kind: 'rewind'; messageId: string; preview: RewindPreview | null }
  | { kind: 'retry'; files: number };

interface RewindModalProps {
  dialog: RewindDialog | null;
  /** A rewind's choice; for a retry, `both` means put the files back. */
  onConfirm: (scope: RewindScope) => void;
  onCancel: () => void;
}

/**
 * The one confirm dialog for rewinding (#166), and for a retry whose reply
 * changed files. Every sentence comes from lib/rewind.ts.
 *
 * With files to offer it has three ways forward, as Claude Code's rewind does:
 * conversation and files (the first, and what most people mean), the
 * conversation alone, or the files alone — and says what a restore cannot put
 * back. Both the height cap and `scrollEnabled` on the body, like every modal
 * that can grow (AGENTS.md): the limits sentence is what pushes the buttons
 * down on a phone.
 */
export function RewindModal({ dialog, onConfirm, onCancel }: RewindModalProps) {
  const reachable = useServerReachable();
  const preview = dialog?.kind === 'rewind' ? dialog.preview : null;
  const loading = dialog?.kind === 'rewind' && preview === null;
  const files = dialog?.kind === 'retry' ? dialog.files : (preview?.files ?? 0);
  const retry = dialog?.kind === 'retry';
  return (
    <Modal isOpen={dialog !== null} onClose={onCancel} size="sm">
      <ModalBackdrop />
      <ModalContent testID="chat.rewind.dialog" className="max-h-[85%]">
        <ModalHeader>
          <HStack space="sm" className="items-center">
            <Icon as={Undo2} size="sm" className="text-foreground" />
            <Heading size="sm">{retry ? 'Answer again?' : 'Rewind to this message?'}</Heading>
          </HStack>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="sm">
            {loading && <Spinner />}
            {preview && (
              <Text testID="chat.rewind.message" size="sm" className="text-foreground">
                {rewindMessage(preview)}
              </Text>
            )}
            {files > 0 && (
              <>
                <Text testID="chat.rewind.filesNote" size="sm" className="text-foreground">
                  {filesMessage(files, retry ? 'retry' : 'rewind')}
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  {FILE_LIMITS}
                </Text>
              </>
            )}
            <DisconnectedNote testID="chat.rewind.disconnected" what="do this" />
          </VStack>
        </ModalBody>
        <ModalFooter>
          <VStack space="sm" className="w-full">
            {files > 0 ? (
              retry ? (
                <>
                  <Button testID="chat.rewind.both" size="sm" isDisabled={!reachable} onPress={() => { onConfirm('both'); }}>
                    <ButtonText>Put files back and answer again</ButtonText>
                  </Button>
                  <Button testID="chat.rewind.conversation" size="sm" variant="outline" isDisabled={!reachable} onPress={() => { onConfirm('conversation'); }}>
                    <ButtonText>Keep the files and answer again</ButtonText>
                  </Button>
                </>
              ) : (
                <>
                  <Button testID="chat.rewind.both" size="sm" isDisabled={!reachable || loading} onPress={() => { onConfirm('both'); }}>
                    <ButtonText>Rewind the conversation and files</ButtonText>
                  </Button>
                  <Button testID="chat.rewind.conversation" size="sm" variant="outline" isDisabled={!reachable || loading} onPress={() => { onConfirm('conversation'); }}>
                    <ButtonText>Rewind the conversation only</ButtonText>
                  </Button>
                  <Button testID="chat.rewind.files" size="sm" variant="outline" isDisabled={!reachable || loading} onPress={() => { onConfirm('files'); }}>
                    <ButtonText>Put the files back only</ButtonText>
                  </Button>
                </>
              )
            ) : (
              <Button testID="chat.rewind.confirm" size="sm" isDisabled={!reachable || loading} onPress={() => { onConfirm('conversation'); }}>
                <ButtonText>{retry ? 'Answer again' : 'Rewind'}</ButtonText>
              </Button>
            )}
            <Button testID="chat.rewind.cancel" size="sm" variant="outline" onPress={onCancel}>
              <ButtonText>Cancel</ButtonText>
            </Button>
          </VStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
