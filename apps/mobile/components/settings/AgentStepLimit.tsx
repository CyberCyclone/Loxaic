import { useEffect, useState } from 'react';
import { getPrefs, updatePrefs } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { useToastHelper } from '@/hooks/useToastHelper';

/** Presets rather than a number field. The useful range is small, the exact
 * value almost never matters, and a free-text box invites 500 — which the API
 * would reject, so the user would meet an error instead of a setting. */
const CHOICES = [5, 10, 20, 50] as const;

/**
 * How many tool round-trips the agent may take for one message.
 *
 * Worth exposing because in auto mode it is the *only* brake — nothing else
 * asks permission — and people genuinely differ: some want the agent to stop
 * and check in early, others want it to finish a long job unattended. Both the
 * effect and the cost of guessing wrong are immediately visible, which is what
 * makes it a good setting rather than a knob.
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
        if (live.current) setValue(prefs.maxIterations);
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

  if (value === null) return null;

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

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Agent steps per message
      </Text>
      <HStack space="xs">
        {CHOICES.map((n) => (
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
        How many tool calls the agent may make while answering one message before it stops and
        hands back. Lower means it checks in with you sooner; higher lets it finish longer jobs
        unattended. It always stops on its own once it has an answer — this is only the ceiling.
      </Text>
    </VStack>
  );
}
