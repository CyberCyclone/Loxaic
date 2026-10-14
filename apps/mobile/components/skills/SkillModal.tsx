import { useEffect, useState } from 'react';
import { isValidSkillName, type SkillInput, type UserSkill } from '@loxaic/api-client';
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
import { Input, InputField } from '@/components/ui/input';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { overrideNote } from '@/lib/skillScreen';

interface SkillModalProps {
  open: boolean;
  onClose: () => void;
  /** Throws the server's own words, shown under the form. */
  onSave: (input: SkillInput) => Promise<void>;
  /** The person's own skill being edited, or null to add one. */
  editing: UserSkill | null;
  /** What a new skill starts from: a built-in being overridden. */
  prefill: Pick<SkillInput, 'name' | 'description' | 'body'> | null;
  /** The built-ins' names, so the form can say a name supersedes one. */
  builtinNames: readonly string[];
}

/**
 * Adds or edits one of a person's own skills (#283): a name, a description of
 * what it does and when to use it, and the instructions — the Agent Skills
 * format's fields. A name equal to a built-in's supersedes that built-in,
 * which the form says as soon as it is typed.
 *
 * Height-capped with a scrolling body: the instructions box is tall, and a
 * phone's keyboard takes half of what is left.
 */
export function SkillModal({ open, onClose, onSave, editing, prefill, builtinNames }: SkillModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [modelInvocable, setModelInvocable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reachable = useServerReachable();

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? prefill?.name ?? '');
    setDescription(editing?.description ?? prefill?.description ?? '');
    setBody(editing?.body ?? prefill?.body ?? '');
    setModelInvocable(editing?.modelInvocable ?? true);
    setError(null);
    setSaving(false);
  }, [open, editing, prefill]);

  const trimmed = name.trim();
  const nameProblem = trimmed && !isValidSkillName(trimmed)
    ? 'Lowercase letters, digits and single hyphens (not at either end), up to 64 characters.'
    : null;
  const note = trimmed && builtinNames.includes(trimmed) ? overrideNote(trimmed) : null;
  const ready = !!trimmed && !nameProblem && !!description.trim() && !!body.trim();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, description: description.trim(), body, modelInvocable });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="lg">
      <ModalBackdrop />
      <ModalContent testID="skillModal.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">{editing ? 'Edit skill' : 'New skill'}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name — what you type after the slash
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="skillModal.name"
                  value={name}
                  onChangeText={setName}
                  placeholder="release-notes"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Input>
              {nameProblem ? (
                <Text testID="skillModal.nameProblem" size="xs" className="text-destructive">
                  {nameProblem}
                </Text>
              ) : note ? (
                <Text testID="skillModal.overrideNote" size="xs" className="text-muted-foreground">
                  {note}
                </Text>
              ) : null}
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Description — what it does and when to use it. The model reads this to decide.
              </Text>
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
                  testID="skillModal.description"
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Writes release notes from merged pull requests. Use when preparing a release."
                  multiline
                  style={{ height: 64 }}
                />
              </Textarea>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Instructions (Markdown)
              </Text>
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
                  testID="skillModal.body"
                  value={body}
                  onChangeText={setBody}
                  placeholder={'1. List the pull requests merged since the last tag.\n2. Group them by area.'}
                  multiline
                  style={{ height: 200 }}
                />
              </Textarea>
            </VStack>

            <HStack space="md" className="items-center justify-between">
              <VStack className="min-w-0 flex-1">
                <Text size="sm" className="text-foreground">
                  Let the model use this skill
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  Off: it runs only when you type its name.
                </Text>
              </VStack>
              <Switch testID="skillModal.modelInvocable" value={modelInvocable} onValueChange={setModelInvocable} />
            </HStack>

            {error && (
              <Text testID="skillModal.error" size="xs" className="text-destructive">
                {error}
              </Text>
            )}
          </VStack>
        </ModalBody>
        <DisconnectedNote testID="skillModal.disconnected" what="save" className="px-4 pt-2" />
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button testID="skillModal.cancel" variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID="skillModal.save"
              size="sm"
              className="bg-primary"
              onPress={() => { void handleSave(); }}
              isDisabled={!ready || saving || !reachable}
            >
              {saving && <ButtonSpinner />}
              <ButtonText className="text-primary-foreground">Save skill</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
