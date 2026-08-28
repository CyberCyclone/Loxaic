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
import { CRON_PRESETS, humanizeCron, validateCron } from '@/lib/fixtures/routines';
import type { Routine } from '@shannon/api-client';

interface RoutineModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: { name: string; cron: string; prompt: string }) => Promise<void>;
  editing?: Routine | null;
}

export function RoutineModal({ open, onClose, onSave, editing }: RoutineModalProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    try {
      await onSave({ name: name.trim(), cron, prompt });
      onClose();
    } catch {
      setError('Failed to save routine');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent>
        <ModalHeader>
          <Heading size="sm">{editing ? 'Edit Routine' : 'New Routine'}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  value={name}
                  onChangeText={setName}
                  placeholder="Daily standup summary"
                />
              </Input>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Prompt
              </Text>
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
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
                <Text size="xs" className="text-destructive">
                  {error}
                </Text>
              )}
            </VStack>
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              size="sm"
              className="bg-primary"
              onPress={() => { void handleSave(); }}
              isDisabled={!name.trim() || saving}
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
