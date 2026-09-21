import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { PresetChips } from './PresetChips';

/** Presets rather than a number field: the exact value almost never matters,
 * and a free-text box invites a number the API rejects, so the user would meet
 * an error instead of a setting. */
const PRESETS = [20, 50, 100, 200] as const;

/**
 * How often the agent stops to ask whether it should keep going.
 *
 * A cadence, not a ceiling — it never cuts the agent off, it pauses and asks
 * (and asks sooner if it notices itself repeating). Worth exposing because
 * people genuinely differ: some want to be consulted early, others want a long
 * job finished unattended. The effect is immediately visible either way, which
 * is what makes it a setting rather than a knob.
 */
export function AgentStepLimit({
  value,
  onChoose,
  disabled,
}: {
  value: number;
  onChoose: (value: number) => void;
  disabled?: boolean;
}) {
  // Controlled by the screen's one `usePrefs`, not a fetch of its own: the
  // "when nobody answers" row a few lines below quotes this number back as the
  // cost of an auto-continue, and with two copies of the pref it kept saying
  // "100 more steps" after this row had been moved to 200.
  // A value the user already has that is not one of the presets — an old 5 or
  // 10 from before this was a cadence, or a number set through the API. Shown
  // as an extra chip so the control never renders with nothing selected, which
  // would read as "unset" and invite an accidental change.
  const choices: number[] = PRESETS.includes(value as (typeof PRESETS)[number])
    ? [...PRESETS]
    : [value, ...PRESETS].sort((a, b) => a - b);

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Steps between check-ins
      </Text>
      <PresetChips
        chips={choices.map((n) => ({ value: n, label: String(n), key: String(n) }))}
        value={value}
        onChoose={onChoose}
        disabled={disabled}
        testIDPrefix="settings.stepLimit"
      />
      <Text size="2xs" className="text-muted-foreground">
        How many tool calls the agent makes while answering one message before it pauses and asks
        whether to keep going, answer with what it has, or stop. It also asks early if it notices
        itself repeating the same calls. It is never cut off, and it always finishes on its own
        once it has an answer.
      </Text>
    </VStack>
  );
}
