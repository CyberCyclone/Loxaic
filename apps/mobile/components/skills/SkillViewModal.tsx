import type { BuiltinSkillView } from '@loxaic/api-client';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Markdown } from '@/components/markdown/Markdown';

/**
 * A built-in skill, read-only: what the model is given when it runs. Built-ins
 * cannot be edited; the screen's Override is how a person changes one.
 */
export function SkillViewModal({ skill, onClose }: { skill: BuiltinSkillView | null; onClose: () => void }) {
  return (
    <Modal isOpen={skill !== null} onClose={onClose} size="lg">
      <ModalBackdrop />
      <ModalContent testID="skillView.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">/{skill?.name ?? ''}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="md">
            {/* The testID on the Text: XCUITest does not expose a container's. */}
            <Text testID="skillView.description" size="sm" className="text-muted-foreground">
              {skill?.description ?? ''}
            </Text>
            {skill?.action === 'compact' ? (
              <Text testID="skillView.action" size="xs" className="text-muted-foreground">
                Loxaic runs this one itself: it compacts the conversation rather than giving the model instructions.
                Only you can run it.
              </Text>
            ) : null}
            <Markdown text={skill?.body ?? ''} size="sm" />
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end border-t border-border">
          <Button testID="skillView.close" variant="outline" size="sm" onPress={onClose}>
            <ButtonText>Close</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
