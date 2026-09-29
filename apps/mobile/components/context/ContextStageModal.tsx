import { Layers } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FitBadge } from '@/components/localModels/FitBadge';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import type { ContextStagesState } from '@/hooks/useContextStages';
import { useServerReachable } from '@/lib/connection';
import { describeFit } from '@/lib/localModels';
import {
  formatExtraMemory,
  formatRereadTime,
  formatWindow,
  nextStage,
  othersWarning,
  stepDownTarget,
} from '@/lib/contextStages';

/**
 * The three questions about a model's context that need a person: the
 * conversation is nearing its window (Compact, or Extend to the next YaRN
 * stage); a reopened conversation needs less than the model is loaded at
 * (keep it, or switch back); and a smaller stage than the conversation is
 * already using (compact first, or cancel).
 *
 * Every one is honest about what a switch does to *other people*: the model
 * is shared, so a reload moves everyone's conversation on it, and the server
 * fills `others` from real use (never names). See lib/contextStages.ts.
 */
export function ContextStageModal({ stages }: { stages: ContextStagesState }) {
  const { dialog } = stages;
  const isOpen = dialog !== null && dialog.kind !== 'settings';
  return (
    <Modal isOpen={isOpen} onClose={stages.close} size="md">
      <ModalBackdrop />
      {dialog?.kind === 'approaching' && <Approaching stages={stages} />}
      {dialog?.kind === 'stepdown' && <StepDown stages={stages} />}
      {dialog?.kind === 'compactFirst' && <CompactFirst stages={stages} target={dialog.target} />}
    </Modal>
  );
}

function Loading({ error }: { error: string | null }) {
  return error ? (
    <Text testID="context.stageModal.error" size="xs" className="text-destructive">
      {error}
    </Text>
  ) : (
    <HStack space="xs" className="items-center">
      <Spinner size="small" />
      <Text size="xs" className="text-muted-foreground">Checking what a switch would cost…</Text>
    </HStack>
  );
}

function Point({ children, tone = 'default' }: { children: string; tone?: 'default' | 'warn' }) {
  return (
    <HStack space="xs" className="items-start">
      <Text size="xs" className={tone === 'warn' ? 'text-warning' : 'text-muted-foreground'}>•</Text>
      <Text size="xs" className={`shrink ${tone === 'warn' ? 'text-warning' : 'text-muted-foreground'}`}>{children}</Text>
    </HStack>
  );
}

function OthersBlock({ stages }: { stages: ContextStagesState }) {
  const warning = stages.info ? othersWarning(stages.info.others, Date.now()) : null;
  if (!warning) return null;
  return (
    <Box testID="context.stageModal.others" className="rounded-md border border-warning/40 bg-warning/10 p-2">
      <Text size="xs" className="text-warning">{warning.text}</Text>
    </Box>
  );
}

function Approaching({ stages }: { stages: ContextStagesState }) {
  const reachable = useServerReachable();
  const { stage, info } = stages;
  if (!stage) return null;
  const next = nextStage(stage);
  const target = next === null ? null : info?.stages[next];
  const nextWindow = next === null ? null : stage.windows[next];
  const warning = info ? othersWarning(info.others, Date.now()) : null;
  const mayChange = info?.may_change ?? stages.mayChange;
  const extra = target ? formatExtraMemory(target.extra_bytes) : null;
  const reread = info ? formatRereadTime(info.reread_seconds) : null;
  const yarn = target?.yarn_factor ? ` (YaRN ${String(target.yarn_factor)}×)` : '';
  const wontFit = target?.fit.label === 'wont-fit';
  return (
    <ModalContent testID="context.stageModal" className="max-h-[85%]">
      <ModalHeader>
        <HStack space="sm" className="min-w-0 shrink items-center">
          <Icon as={Layers} size="sm" className="shrink-0 text-warning" />
          <Heading size="sm" className="min-w-0 shrink">This conversation is nearly full</Heading>
        </HStack>
      </ModalHeader>
      <ModalBody scrollEnabled>
        <VStack space="md">
          <Text size="sm" className="text-foreground">
            {`It is close to this model's ${formatWindow(stage.windows[stage.active])} context. You can summarise the older turns, or give the model more room.`}
          </Text>

          <VStack space="xs">
            <Text size="sm" className="font-medium text-foreground">Compact</Text>
            <Point>Stays fast and uses no extra memory.</Point>
            <Point>Older turns become a summary, so some detail is lost.</Point>
          </VStack>

          {nextWindow !== null && (
            <VStack space="xs">
              <HStack space="sm" className="items-center">
                <Text size="sm" className="font-medium text-foreground">{`Extend to ${formatWindow(nextWindow)}${yarn}`}</Text>
                {target && <FitBadge label={target.fit.label} testID="context.stageModal.fit" />}
              </HStack>
              <Point>Keeps everything word for word.</Point>
              {extra && <Point>{`Needs ${extra}.`}</Point>}
              {target && wontFit && <Point tone="warn">{describeFit(target.fit)}</Point>}
              <Point>{`Reloads the model${reread ? ` and re-reads this conversation once (${reread})` : ' and re-reads this conversation once'}.`}</Point>
              <Point>YaRN can slightly lower quality on short prompts, for everyone, until someone switches back.</Point>
              <Point>Every reply gets slower as the context grows.</Point>
            </VStack>
          )}

          {!info ? <Loading error={stages.infoError} /> : <OthersBlock stages={stages} />}
          {!mayChange && (
            <Text testID="context.stageModal.admins" size="xs" className="text-muted-foreground">
              An admin controls this model's context, so Compact is what you can do here.
            </Text>
          )}
        </VStack>
      </ModalBody>
      <ModalFooter className="flex-col items-stretch gap-2">
        <DisconnectedNote testID="context.stageModal.disconnected" what="change the context" />
        <HStack space="sm" className="flex-wrap justify-end">
          <Button testID="context.stageModal.notNow" variant="outline" size="sm" onPress={stages.close}>
            <ButtonText>Not now</ButtonText>
          </Button>
          <Button testID="context.stageModal.compact" variant="outline" size="sm" isDisabled={!reachable} onPress={stages.compact}>
            <ButtonText>Compact</ButtonText>
          </Button>
          {nextWindow !== null && mayChange && (
            <Button
              testID="context.stageModal.extend"
              size="sm"
              className="bg-primary"
              isDisabled={!reachable || !info || stages.requesting || wontFit}
              onPress={() => { void stages.extend(); }}
            >
              <ButtonText className="text-primary-foreground">
                {warning?.waits ? `Extend when free` : `Extend to ${formatWindow(nextWindow)}`}
              </ButtonText>
            </Button>
          )}
        </HStack>
      </ModalFooter>
    </ModalContent>
  );
}

function StepDown({ stages }: { stages: ContextStagesState }) {
  const reachable = useServerReachable();
  const { stage, info } = stages;
  if (!stage) return null;
  const target = info ? stepDownTarget(info) : 0;
  const targetWindow = stage.windows[target];
  const targetIsStandard = target === 0;
  const warning = info ? othersWarning(info.others, Date.now()) : null;
  const reread = info ? formatRereadTime(info.reread_seconds) : null;
  return (
    <ModalContent testID="context.stageModal.stepDown" className="max-h-[85%]">
      <ModalHeader>
        <HStack space="sm" className="min-w-0 shrink items-center">
          <Icon as={Layers} size="sm" className="shrink-0 text-muted-foreground" />
          <Heading size="sm" className="min-w-0 shrink">This model has extended context on</Heading>
        </HStack>
      </ModalHeader>
      <ModalBody scrollEnabled>
        <VStack space="md">
          <Text size="sm" className="text-foreground">
            {`It is running at ${formatWindow(stage.windows[stage.active])} with YaRN, and this conversation needs much less.`}
          </Text>
          <VStack space="xs">
            <Text size="sm" className="font-medium text-foreground">{`Keep ${formatWindow(stage.windows[stage.active])}`}</Text>
            <Point>No reload, and this conversation can grow without another switch.</Point>
            <Point>YaRN slightly lowers quality on short prompts, and every reply uses more memory.</Point>
          </VStack>
          <VStack space="xs">
            <Text size="sm" className="font-medium text-foreground">
              {targetIsStandard ? `Switch back to standard (${formatWindow(targetWindow)})` : `Switch to ${formatWindow(targetWindow)}`}
            </Text>
            <Point>{targetIsStandard ? 'Full quality on short prompts, and less memory.' : 'Less memory, with room for this conversation.'}</Point>
            <Point>{`Reloads the model${reread ? ` and re-reads this conversation once (${reread})` : ''}.`}</Point>
          </VStack>
          {!info ? <Loading error={stages.infoError} /> : <OthersBlock stages={stages} />}
        </VStack>
      </ModalBody>
      <ModalFooter className="flex-col items-stretch gap-2">
        <DisconnectedNote testID="context.stageModal.disconnected" what="change the context" />
        <HStack space="sm" className="flex-wrap justify-end">
          <Button testID="context.stageModal.keep" variant="outline" size="sm" onPress={stages.close}>
            <ButtonText>{`Keep ${formatWindow(stage.windows[stage.active])}`}</ButtonText>
          </Button>
          <Button
            testID="context.stageModal.switchDown"
            size="sm"
            className="bg-primary"
            isDisabled={!reachable || !info || stages.requesting}
            onPress={() => { void stages.stepDown(); }}
          >
            <ButtonText className="text-primary-foreground">
              {warning?.waits ? 'Switch when free' : targetIsStandard ? 'Switch to standard' : `Switch to ${formatWindow(targetWindow)}`}
            </ButtonText>
          </Button>
        </HStack>
      </ModalFooter>
    </ModalContent>
  );
}

function CompactFirst({ stages, target }: { stages: ContextStagesState; target: number }) {
  const reachable = useServerReachable();
  const { stage } = stages;
  if (!stage) return null;
  const window = stage.windows[target];
  return (
    <ModalContent testID="context.stageModal.compactFirst" className="max-h-[85%]">
      <ModalHeader>
        <HStack space="sm" className="min-w-0 shrink items-center">
          <Icon as={Layers} size="sm" className="shrink-0 text-warning" />
          <Heading size="sm" className="min-w-0 shrink">Compact first?</Heading>
        </HStack>
      </ModalHeader>
      <ModalBody scrollEnabled>
        <VStack space="sm">
          <Text testID="context.stageModal.compactFirst.message" size="sm" className="text-foreground">
            {`This conversation is about ${formatWindow(stages.usedTokens)} tokens; ${formatWindow(window)} can't hold it. Compact it first — older turns become a summary — then switch?`}
          </Text>
          <Text size="xs" className="text-muted-foreground">
            If it is still too large after compacting, the context stays where it is and this says so.
          </Text>
        </VStack>
      </ModalBody>
      <ModalFooter className="justify-end">
        <HStack space="sm" className="flex-wrap justify-end">
          <Button testID="context.stageModal.cancel" variant="outline" size="sm" onPress={stages.close}>
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button
            testID="context.stageModal.compactAndSwitch"
            size="sm"
            className="bg-primary"
            isDisabled={!reachable || stages.requesting}
            onPress={() => { void stages.confirmCompactFirst(); }}
          >
            <ButtonText className="text-primary-foreground">Compact and switch</ButtonText>
          </Button>
        </HStack>
      </ModalFooter>
    </ModalContent>
  );
}
