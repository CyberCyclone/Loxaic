import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { changeConversationImage, getImageChoices, ImageApiError, type ImageChoice } from '@loxaic/api-client';
import type { Workspace } from '@loxaic/types';
import { imageOptions } from '@/lib/customImages';
import { IMAGE_SWITCH_NOTE } from '@/lib/imageSwitch';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';

interface ImageSwitchModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  /** The image it runs in now; null is Loxaic's own. */
  currentImageId: string | null;
  source: 'scratch' | 'github';
  /** The workspace as it now is, once the server has moved it. */
  onChanged: (workspace: Workspace | null) => void;
}

/**
 * Moves an agent conversation to another image (#253). The server copies the
 * workspace's files across and refuses while a run is going; this says what
 * moves and what doesn't before anyone presses the button.
 */
export function ImageSwitchModal({ open, onClose, conversationId, currentImageId, source, onChanged }: ImageSwitchModalProps) {
  const reachable = useServerReachable();
  const [choices, setChoices] = useState<ImageChoice[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(currentImageId);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChosen(currentImageId);
    setError(null);
    setChoices(null);
    getImageChoices()
      .then(setChoices)
      .catch(() => { setChoices([]); });
  }, [open, currentImageId]);

  const options = imageOptions(choices ?? [], source);
  const unchanged = chosen === currentImageId;

  const move = async () => {
    setMoving(true);
    setError(null);
    try {
      const { workspace } = await changeConversationImage(conversationId, chosen ? { id: chosen } : null);
      onChanged(workspace);
      onClose();
    } catch (err) {
      setError(err instanceof ImageApiError ? err.message : describeRequestError(err, "Couldn't change the image"));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={moving ? () => undefined : onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="agent.imageSwitch.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Change image</Heading>
          <ModalCloseButton disabled={moving}>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="sm">
            <DisconnectedNote testID="agent.imageSwitch.disconnected" />
            {choices === null ? (
              <Spinner />
            ) : (
              options.map((o) => (
                <Pressable
                  key={o.id ?? 'builtin'}
                  testID={`agent.imageSwitch.option.${o.id ?? 'builtin'}`}
                  aria-selected={chosen === o.id}
                  disabled={o.disabledReason !== null || moving}
                  onPress={() => { setChosen(o.id); }}
                  className={`rounded-md border px-3 py-2.5 ${chosen === o.id ? 'border-primary bg-primary/10' : 'border-border bg-card'} ${o.disabledReason ? 'opacity-50' : ''}`}
                >
                  <HStack space="sm" className="items-center">
                    <Icon as={Layers} size="sm" className={chosen === o.id ? 'text-primary' : 'text-muted-foreground'} />
                    <VStack className="min-w-0 flex-1">
                      <Text size="sm" className="text-foreground">
                        {o.label}{o.id === currentImageId ? ' (now)' : ''}
                      </Text>
                      <Text size="xs" className="text-muted-foreground">
                        {o.disabledReason ?? o.detail}
                      </Text>
                    </VStack>
                  </HStack>
                </Pressable>
              ))
            )}
            <Text testID="agent.imageSwitch.note" size="xs" className="text-muted-foreground">
              {IMAGE_SWITCH_NOTE}
            </Text>
            {moving && (
              <HStack space="sm" className="items-center">
                <Spinner />
                <Text testID="agent.imageSwitch.moving" size="xs" className="text-muted-foreground">
                  Moving your files to the new image…
                </Text>
              </HStack>
            )}
            {error && (
              <Text testID="agent.imageSwitch.error" size="xs" className="text-destructive">
                {error}
              </Text>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="border-t border-border">
          <Button testID="agent.imageSwitch.confirm" isDisabled={unchanged || moving || !reachable || choices === null} onPress={() => { void move(); }}>
            <ButtonText>Move to this image</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
