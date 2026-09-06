import { useEffect, useState } from 'react';
import { getPrefs, updatePrefs } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { useToastHelper } from '@/hooks/useToastHelper';

/**
 * Auto-compaction is a server-side preference, so this reads and writes
 * `/v1/prefs` directly rather than joining the modal's local draft — the same
 * immediate-apply shape the theme buttons already use.
 *
 * Both outcomes are spelled out, not just the one being turned on. This
 * setting trades two unlike things against each other — losing detail from old
 * turns, versus a conversation that eventually stops working — and neither is
 * guessable from a switch labelled "auto-compact". The inactive branch stays
 * on screen, dimmed, so the choice reads as a comparison rather than a dare.
 */
export function AutoCompactToggle() {
  const { showToast } = useToastHelper();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Ref-shaped rather than a plain `let`: the cleanup below assigns it after
    // the async body has already captured it, which a bare boolean lets the
    // type checker narrow away as always-false.
    const live = { current: true };
    void (async () => {
      try {
        const prefs = await getPrefs();
        if (live.current) setEnabled(prefs.autoCompact);
      } catch {
        // Offline or an old server: leave the control out entirely rather than
        // showing a state that might not be the server's.
        if (live.current) setEnabled(null);
      }
    })();
    return () => {
      live.current = false;
    };
  }, []);

  if (enabled === null) return null;

  const change = (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic: the switch must not lag the thumb
    setBusy(true);
    void (async () => {
      try {
        await updatePrefs({ autoCompact: next });
      } catch (err) {
        setEnabled(previous);
        showToast(`Could not save: ${(err as Error).message}`, 5000);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Long conversations
      </Text>
      <HStack space="sm" className="items-center">
        <Switch
          testID="settings.autoCompact.toggle"
          value={enabled}
          onValueChange={change}
          isDisabled={busy}
        />
        <Text size="sm" className="flex-1 text-foreground">
          Summarise older messages when a conversation fills the model&apos;s context
        </Text>
      </HStack>

      <VStack space="xs" className="mt-1">
        <Outcome
          active={enabled}
          testID="settings.autoCompact.onCopy"
          label="On"
          body="Once a conversation nears the model's context limit, the older messages are replaced by a summary so it can keep going. Nothing is deleted — the full transcript stays on screen; only what gets sent to the model changes. Detail from early turns can be lost, and the turn that compacts is slower."
        />
        <Outcome
          active={!enabled}
          testID="settings.autoCompact.offCopy"
          label="Off"
          body="Every message is sent word-for-word for as long as it fits. When a conversation outgrows the model's context limit, replies start failing — you would then run /compact yourself, or start a new chat."
        />
      </VStack>
    </VStack>
  );
}

/** The branch in force is readable; the other stays visible but dimmed, so the
 * consequence of flipping the switch is on screen before you flip it. */
function Outcome({
  active,
  label,
  body,
  testID,
}: {
  active: boolean;
  label: string;
  body: string;
  testID: string;
}) {
  return (
    <Box
      className={`rounded-md border px-2.5 py-2 ${
        active ? 'border-border bg-card' : 'border-transparent bg-muted/30'
      }`}
    >
      <Text size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
        <Text size="2xs" className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>
          {label}
          {active ? ' (current)' : ''}:{' '}
        </Text>
        <Text testID={testID} size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
          {body}
        </Text>
      </Text>
    </Box>
  );
}
