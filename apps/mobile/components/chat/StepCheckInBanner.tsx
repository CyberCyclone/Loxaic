import type { CheckinReason } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';

/**
 * Shown when a run has paused to ask whether to keep going.
 *
 * A banner in the normal flow above the composer, deliberately — not a modal
 * and not an overlay. The question is "should this carry on?", and the only
 * way to answer it is to look at what the agent has already done, so the
 * transcript has to stay readable and scrollable behind it. A dialog would
 * cover the one thing the decision depends on.
 *
 * It is written in the agent's own voice for the same reason the decision is
 * the user's: "the run hit iteration 100 of 100" is a fact about our
 * bookkeeping, whereas "I've taken 100 steps and haven't finished" is the
 * thing being asked about.
 *
 * Shared by chat and agent, which share one tool loop — a check-in is not an
 * agent-surface feature and the chat surface must not silently drop the
 * question.
 */

interface StepCheckInBannerProps {
  /** Steps taken so far, and the end of the current window. */
  n: number;
  max: number;
  reason: CheckinReason;
  /** For a loop, the calls that keep repeating. */
  pattern?: { tool: string }[];
  onContinue: () => void;
  onAnswer: () => void;
  onStop: () => void;
}

/** The repeating tools, in order, without repeating a name twice in a row —
 * the pattern is a cycle, so `grep → grep` reads as a bug in us rather than a
 * loop in the model. */
function describePattern(pattern: { tool: string }[]): string {
  const names = pattern.map((p) => p.tool).filter((name, i, all) => i === 0 || all[i - 1] !== name);
  return names.join(' → ');
}

export function StepCheckInBanner({ n, max, reason, pattern, onContinue, onAnswer, onStop }: StepCheckInBannerProps) {
  const repeating = pattern?.length ? describePattern(pattern) : null;
  return (
    <VStack
      testID="checkin.banner"
      space="xs"
      className="border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      <Text testID="checkin.reason" size="sm" className="text-foreground">
        {reason === 'loop' ? (
          <>
            I&apos;ve been at this a while and might be stuck in a loop
            {repeating ? (
              <>
                {' — I keep running '}
                <Text size="sm" className="font-mono text-warning">{repeating}</Text>
              </>
            ) : null}
            . Should I keep going, or answer with what I have?
          </>
        ) : (
          <>
            {`I've taken ${String(n)} ${n === 1 ? 'step' : 'steps'} on this and haven't finished yet. `}
            Should I keep going, or answer with what I have?
          </>
        )}
      </Text>
      {/* The window is worth saying out loud: it is a setting, and someone
          asked this every few minutes should be able to connect the two. */}
      <Text size="xs" className="text-muted-foreground">
        {`Step ${String(n)} of ${String(max)} — you can change how often I check in from Settings.`}
      </Text>
      <HStack space="sm" className="justify-end">
        <Button testID="checkin.stop" variant="link" size="sm" onPress={onStop}>
          <ButtonText>Stop</ButtonText>
        </Button>
        <Button testID="checkin.answer" variant="outline" size="sm" onPress={onAnswer}>
          <ButtonText>Answer now</ButtonText>
        </Button>
        <Button testID="checkin.continue" size="sm" onPress={onContinue}>
          <ButtonText>Keep going</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
