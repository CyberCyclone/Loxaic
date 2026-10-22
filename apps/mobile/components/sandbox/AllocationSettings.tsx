import { useEffect, useState } from 'react';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { AllocationFields } from '@/components/sandbox/AllocationFields';
import { draftFrom, parseAllocationDraft, type AllocationDraft } from '@/lib/sandboxAllocation';
import type { SandboxAllocation } from '@loxaic/api-client';

/**
 * The default sandbox allocation every user gets (#254), unless an admin
 * overrides theirs in Admin → Users. Saved with one button, since the three
 * parts are read together; every field must hold a value here.
 */
export function AllocationSettings({
  allocation,
  maxRunningPinned,
  unavailable,
  onSave,
}: {
  allocation: SandboxAllocation;
  maxRunningPinned: boolean;
  unavailable: boolean;
  onSave: (patch: Partial<SandboxAllocation>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AllocationDraft>(() => draftFrom(allocation));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Follows the saved value (another admin's change, or this save's answer)
  // whenever nothing is being typed over it.
  const saved = draftFrom(allocation);
  const dirty = draft.memoryGb !== saved.memoryGb || draft.cpus !== saved.cpus || draft.maxRunning !== saved.maxRunning;
  const savedKey = `${saved.memoryGb}|${saved.cpus}|${saved.maxRunning}`;
  useEffect(() => {
    if (!saving) setDraft(draftFrom(allocation));
    // Keyed on the saved values, not the object, which is new on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const save = async () => {
    const parsed = parseAllocationDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const { memoryMb, cpus, maxRunning } = parsed.value;
    if (memoryMb == null || cpus == null || (maxRunning == null && !maxRunningPinned)) {
      setError('Fill in every field: this is what everyone gets by default.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ memoryMb, cpus, ...(maxRunningPinned || maxRunning == null ? {} : { maxRunning }) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the allocation.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack space="sm">
      <Text size="xs" className="text-muted-foreground">
        Default allocation per user
      </Text>
      <Text size="xs" className="text-muted-foreground">
        What one person&apos;s running sandboxes may hold together. Paused sandboxes hold none of it. A start that would
        not fit is refused, and the person pauses one of theirs; nothing is paused for them.
      </Text>
      <AllocationFields
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          setError(null);
        }}
        testIDPrefix="sandbox.allocation"
        locked={{ memoryGb: unavailable, cpus: unavailable, maxRunning: unavailable || maxRunningPinned }}
      />
      {maxRunningPinned && (
        <Text size="2xs" className="text-muted-foreground">
          Running at once is set by the SANDBOX_MAX_PER_USER environment variable.
        </Text>
      )}
      {error && (
        <Text testID="sandbox.allocation.error" size="xs" className="text-destructive">
          {error}
        </Text>
      )}
      <Button
        testID="sandbox.allocation.save"
        size="sm"
        className="self-start"
        isDisabled={!dirty || saving || unavailable}
        onPress={() => { void save(); }}
      >
        <ButtonText>{saving ? 'Saving…' : 'Save allocation'}</ButtonText>
      </Button>
    </VStack>
  );
}
