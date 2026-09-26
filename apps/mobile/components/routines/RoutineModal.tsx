import { useEffect, useState } from 'react';
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
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { ChevronRight } from 'lucide-react-native';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { CRON_PRESETS, humanizeCron, validateCron } from '@/lib/fixtures/routines';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import type { Routine } from '@loxaic/api-client';

interface RoutineModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: { name: string; cron: string; prompt: string; model: string }) => Promise<void>;
  editing?: Routine | null;
  /**
   * The model this routine will run on, and the picker that changes it.
   *
   * Lifted to the screen rather than held here, so the picker renders as a
   * sibling of this modal rather than on top of it — the app does not stack
   * modals anywhere else, and native's behaviour when it does is its own
   * problem to discover.
   *
   * Null means nothing is chosen yet: a routine written before this field
   * existed. Those are the only ones, and they cannot be saved until a model
   * is picked, because there is no default for the server to fall back to.
   */
  model: string | null;
  modelLabel: string | null;
  onOpenModelPicker: () => void;
}

export function RoutineModal({
  open,
  onClose,
  onSave,
  editing,
  model,
  modelLabel,
  onOpenModelPicker,
}: RoutineModalProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reachable = useServerReachable();

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setPrompt(editing?.prompt ?? '');
      setCron(editing?.cron ?? '0 9 * * 1-5');
      setError(null);
      setSaving(false);
    }
  }, [open, editing]);

  const handleSave = async () => {
    const cronErr = validateCron(cron);
    if (cronErr) {
      setError(cronErr);
      return;
    }
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!model) {
      setError('Choose a model for this routine to run on');
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), cron, prompt, model });
      onClose();
    } catch (err) {
      // The server's own words. It refuses a cron it could never schedule and
      // a model it cannot resolve, and both messages say what to do about it —
      // which "Failed to save routine" threw away.
      setError(err instanceof Error ? err.message : 'Failed to save routine');
    } finally {
      setSaving(false);
    }
  };

  return (
    // Both halves, and both are needed. The vendored ModalBody hardcodes
    // `scrollEnabled={false}` before its prop spread, and ModalContent has no
    // height cap — so the Model row added below would push Save past the fold
    // with nothing able to scroll to it. See AGENTS.md on SettingsModal and
    // McpServerModal, where exactly this cost a credential.
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">{editing ? 'Edit Routine' : 'New Routine'}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="routineModal.name"
                  value={name}
                  onChangeText={setName}
                  placeholder="Daily standup summary"
                />
              </Input>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Model
              </Text>
              {/* Every run uses this one, and so does a reply typed into a
                  run's chat afterwards. There is no fallback on the server:
                  a routine with no model fails its runs and says so. */}
              <Pressable
                testID="routineModal.model"
                onPress={onOpenModelPicker}
                className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5"
              >
                <Text
                  size="sm"
                  className={modelLabel ? 'text-foreground' : 'text-muted-foreground'}
                  numberOfLines={1}
                  style={TRUNCATE_TEXT}
                >
                  {modelLabel ?? 'Choose a model'}
                </Text>
                <Icon as={ChevronRight} size="sm" className="shrink-0 text-muted-foreground" />
              </Pressable>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Prompt
              </Text>
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
                  testID="routineModal.prompt"
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Summarize yesterday's commits..."
                  multiline
                  style={{ height: 80 }}
                />
              </Textarea>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Schedule
              </Text>
              <HStack space="xs" className="flex-wrap">
                {CRON_PRESETS.map((p) => (
                  <Pressable
                    key={p.cron}
                    onPress={() => {
                      setCron(p.cron);
                      setError(null);
                    }}
                    className={`rounded-full px-3 py-1.5 ${cron === p.cron ? 'bg-primary/15' : 'bg-muted'}`}
                  >
                    <Text size="xs" className={cron === p.cron ? 'text-primary' : 'text-muted-foreground'}>
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </HStack>
              <Input className="mt-1 border-border bg-card">
                <InputField
                  testID="routineModal.cron"
                  value={cron}
                  onChangeText={(v) => {
                    setCron(v);
                    setError(validateCron(v));
                  }}
                  placeholder="0 9 * * 1-5"
                  autoCapitalize="none"
                  style={{ fontFamily: 'ui-monospace' }}
                />
              </Input>
              <Text size="xs" className="text-muted-foreground">
                {humanizeCron(cron)}
              </Text>
              {error && (
                <Text testID="routineModal.error" size="xs" className="text-destructive">
                  {error}
                </Text>
              )}
            </VStack>
          </VStack>
        </ModalBody>
        <DisconnectedNote testID="routineModal.disconnected" what="save" className="px-4 pt-2" />
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID="routineModal.save"
              size="sm"
              className="bg-primary"
              onPress={() => { void handleSave(); }}
              // No model, no save: there is nothing for the server to fall
              // back to, and a routine saved without one would simply fail
              // every run.
              isDisabled={!name.trim() || !model || saving || !reachable}
            >
              {saving && <ButtonSpinner />}
              <ButtonText className="text-primary-foreground">Save routine</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
