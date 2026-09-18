import { useEffect, useState } from 'react';
import { getPrefs, updatePrefs } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { useToastHelper } from '@/hooks/useToastHelper';

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
export function AgentStepLimit() {
  const { showToast } = useToastHelper();
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // See AutoCompactToggle for why this is ref-shaped rather than a boolean.
    const live = { current: true };
    void (async () => {
      try {
        const prefs = await getPrefs();
        // `?? null`, because a server predating this field does not throw —
        // it answers 200 with the key simply absent, and `undefined` would
        // sail past the `=== null` guard below and render a control with
        // nothing selected. A newer client against an older host is a
        // supported configuration (desktop Client mode, any remote host).
        if (live.current) setValue(prefs.maxIterations ?? null);
      } catch {
        // Offline, or a server that predates this setting: show nothing rather
        // than a value that might not be the server's.
        if (live.current) setValue(null);
      }
    })();
    return () => {
      live.current = false;
    };
  }, []);

  if (value == null) return null;

  const choose = (next: number) => {
    const previous = value;
    setValue(next);
    setBusy(true);
    void (async () => {
      try {
        await updatePrefs({ maxIterations: next });
      } catch (err) {
        setValue(previous);
        showToast(`Could not save: ${(err as Error).message}`, 5000);
      } finally {
        setBusy(false);
      }
    })();
  };

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
      <HStack space="xs">
        {choices.map((n) => (
          <Pressable
            key={n}
            testID={`settings.stepLimit.${String(n)}`}
            disabled={busy}
            onPress={() => { choose(n); }}
            className={`rounded-full px-3 py-1.5 ${value === n ? 'bg-primary/15' : 'bg-muted'}`}
          >
            <Text size="sm" className={value === n ? 'text-primary' : 'text-muted-foreground'}>
              {n}
            </Text>
          </Pressable>
        ))}
      </HStack>
      <Text size="2xs" className="text-muted-foreground">
        How many tool calls the agent makes while answering one message before it pauses and asks
        whether to keep going, answer with what it has, or stop. It also asks early if it notices
        itself repeating the same calls. It is never cut off, and it always finishes on its own
        once it has an answer.
      </Text>
    </VStack>
  );
}
