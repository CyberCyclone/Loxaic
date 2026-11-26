import { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavouriteQuestion } from '@loxaic/api-client';
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
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { draftProblem } from '@/lib/favouriteQuestions';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';

interface AddFavouriteModalProps {
  open: boolean;
  onClose: () => void;
  /** Throws the server's own words, shown under the field. */
  onSave: (text: string) => Promise<void>;
  /** The list as shown, so a question already there is said before asking. */
  existing: readonly FavouriteQuestion[];
}

/**
 * Adds one favourite question: a question the person asks often, sent as it
 * is when tapped on the new-chat screen. Lifted above the keyboard on a phone
 * the way SkillModal is: Return in the field is a new line, so nothing else
 * would put the keyboard away from over the footer.
 */
export function AddFavouriteModal({ open, onClose, onSave, existing }: AddFavouriteModalProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reachable = useServerReachable();
  const keyboard = useKeyboardHeight();
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const lifted = keyboard > 0
    ? { marginBottom: keyboard, maxHeight: Math.max(240, screen.height - keyboard - insets.top - 16) }
    : undefined;

  useEffect(() => {
    if (!open) return;
    setDraft('');
    setError(null);
    setSaving(false);
  }, [open]);

  const problem = draftProblem(draft, existing);
  const ready = !!draft.trim() && !problem;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save the question');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="favourites.modal" className={lifted ? '' : 'max-h-[85%]'} style={lifted}>
        <ModalHeader>
          <Heading size="sm">Add a favourite question</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <VStack space="sm">
            <Text size="xs" className="text-muted-foreground">
              A question you ask often. Tapping it on a new chat sends it straight away.
            </Text>
            <Textarea size="md" className="border-border bg-card">
              <TextareaInput
                testID="favourites.modal.input"
                value={draft}
                onChangeText={setDraft}
                placeholder="What should I cook tonight?"
                multiline
                autoFocus
                style={{ height: 96 }}
              />
            </Textarea>
            {(problem ?? error) && (
              <Text testID="favourites.modal.error" size="xs" className="text-destructive">
                {problem ?? error}
              </Text>
            )}
          </VStack>
        </ModalBody>
        <DisconnectedNote testID="favourites.modal.disconnected" what="save" className="px-4 pt-2" />
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button testID="favourites.modal.cancel" variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID="favourites.modal.save"
              size="sm"
              className="bg-primary"
              onPress={() => { void handleSave(); }}
              isDisabled={!ready || saving || !reachable}
            >
              {saving && <ButtonSpinner />}
              <ButtonText className="text-primary-foreground">Save</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
