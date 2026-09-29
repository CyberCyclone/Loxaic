import { Check, Layers } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CloseIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { FitBadge } from '@/components/localModels/FitBadge';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import type { ContextStagesState } from '@/hooks/useContextStages';
import { useServerReachable } from '@/lib/connection';
import { describeFit } from '@/lib/localModels';
import { formatExtraMemory, othersWarning, stageLabel } from '@/lib/contextStages';
import { TRUNCATE_TEXT } from '@/lib/truncate';

/**
 * Context settings, from the composer's `+`: every stage this model can be
 * loaded at, with what each costs in memory, and a choice — before a chat
 * exists (it rides the first send) or in the middle of one (a stage run).
 *
 * Both halves of the scroll fix (AGENTS.md): height-bounded and
 * `ModalBody scrollEnabled`, because a model can have six stages and a
 * warning above them.
 */
export function ContextSettingsSheet({ stages }: { stages: ContextStagesState }) {
  const reachable = useServerReachable();
  const isOpen = stages.dialog?.kind === 'settings';
  const { stage, info } = stages;
  const warning = info ? othersWarning(info.others, Date.now()) : null;
  const mayChange = info?.may_change ?? stages.mayChange;
  const chosen = stages.pendingStage;
  const current = chosen ?? stage?.active ?? 0;

  return (
    <Modal isOpen={isOpen} onClose={stages.close} size="md">
      <ModalBackdrop />
      <ModalContent testID="context.settings" className="max-h-[85%]">
        <ModalHeader>
          <HStack space="sm" className="min-w-0 flex-1 shrink items-center pr-2">
            <Icon as={Layers} size="sm" className="shrink-0 text-muted-foreground" />
            <VStack className="min-w-0 shrink">
              <Heading size="sm" numberOfLines={1} style={TRUNCATE_TEXT}>Context settings</Heading>
              <Text size="xs" className="text-muted-foreground">
                {stages.serverConvId ? 'How much this model can read at once.' : 'Chosen now, applied when you send.'}
              </Text>
            </VStack>
          </HStack>
          <ModalCloseButton testID="context.settings.close">
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="md">
            {!info && !stages.infoError && (
              <HStack space="xs" className="items-center">
                <Spinner size="small" />
                <Text size="xs" className="text-muted-foreground">Reading the stages…</Text>
              </HStack>
            )}
            {stages.infoError && (
              <Text testID="context.settings.error" size="xs" className="text-destructive">{stages.infoError}</Text>
            )}

            {info?.stages.map((s) => {
              const selected = s.index === current;
              const extra = s.index > info.active ? formatExtraMemory(s.extra_bytes) : null;
              const disabled = !mayChange || !reachable;
              return (
                <Pressable
                  key={s.index}
                  testID={`context.settings.stage.${String(s.index)}`}
                  disabled={disabled}
                  aria-checked={selected}
                  role="radio"
                  onPress={() => { void stages.choose(s.index); }}
                  className={`rounded-md border p-3 ${selected ? 'border-primary bg-primary/10' : 'border-border'} ${disabled ? 'opacity-60' : 'web:hover:bg-muted/50'}`}
                >
                  <HStack space="sm" className="items-center">
                    <Box className="w-4">{selected && <Icon as={Check} size="xs" className="text-primary" />}</Box>
                    <VStack className="min-w-0 flex-1 shrink">
                      <Text size="sm" className="font-medium text-foreground">{stageLabel(s.context_tokens, s.yarn_factor, s.index === 0)}</Text>
                      <HStack space="xs" className="flex-wrap items-center">
                        {s.index === info.active && <Text size="2xs" className="text-muted-foreground">Current</Text>}
                        {s.index === info.recommended && info.conversation_tokens !== null && (
                          <Text size="2xs" className="text-muted-foreground">Recommended for this chat</Text>
                        )}
                        {extra && <Text size="2xs" className="text-muted-foreground">{extra}</Text>}
                      </HStack>
                      {s.fit.label === 'wont-fit' && (
                        <Text size="2xs" className="text-destructive">{describeFit(s.fit)}</Text>
                      )}
                    </VStack>
                    <FitBadge label={s.fit.label} testID={`context.settings.stage.${String(s.index)}.fit`} />
                  </HStack>
                </Pressable>
              );
            })}

            {warning && (
              <Box testID="context.settings.others" className="rounded-md border border-warning/40 bg-warning/10 p-2">
                <Text size="xs" className="text-warning">{warning.text}</Text>
              </Box>
            )}
            {info && !mayChange && (
              <Text testID="context.settings.admins" size="xs" className="text-muted-foreground">
                An admin controls this model's context.
              </Text>
            )}
            <Text size="2xs" className="text-muted-foreground">
              Extended stages use YaRN, which stretches the model's positions to reach a longer context. It applies to every conversation on this model while it is on, and slightly lowers quality on short prompts.
            </Text>
          </VStack>
        </ModalBody>
        <ModalFooter className="flex-col items-stretch gap-2">
          <DisconnectedNote testID="context.settings.disconnected" what="change the context" />
          <HStack className="justify-end">
            <Button testID="context.settings.done" variant="outline" size="sm" onPress={stages.close}>
              <ButtonText>Close</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
