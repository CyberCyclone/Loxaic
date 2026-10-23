import { useEffect, useState } from 'react';
import {
  adminClearUserSandboxAllocation,
  adminSetUserSandboxAllocation,
  type AdminUser,
  type UserSandboxAllocation,
} from '@loxaic/api-client';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Button, ButtonText } from '@/components/ui/button';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { AllocationFields } from '@/components/sandbox/AllocationFields';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import {
  allocationSummary,
  anyOverridden,
  changedParts,
  draftFrom,
  parseAllocationDraft,
  type AllocationDraft,
} from '@/lib/sandboxAllocation';

const EMPTY: AllocationDraft = { memoryGb: '', cpus: '', maxRunning: '' };

/**
 * One user's sandbox allocation (#254), from Admin → Users: an empty field
 * follows the server-wide default, a filled one is set for them alone.
 * Lowering it pauses nothing; it only refuses their next start.
 */
export function UserAllocationModal({
  user,
  maxRunningPinned,
  onClose,
  onSaved,
}: {
  /** The user, as listed with their allocation; null when closed. */
  user: (AdminUser & { sandbox: UserSandboxAllocation }) | null;
  /** SANDBOX_MAX_PER_USER sets the count for everyone. */
  maxRunningPinned: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const reachable = useServerReachable();
  const [draft, setDraft] = useState<AllocationDraft>(EMPTY);
  // The fields as the dialog opened: only what changed from them is sent.
  const [opened, setOpened] = useState<AllocationDraft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Built once per opening from the row it opened on, never the polled list.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!user) return;
    const { allocation, overridden } = user.sandbox;
    const initial = draftFrom({
      ...(overridden.memoryMb ? { memoryMb: allocation.memoryMb } : {}),
      ...(overridden.cpus ? { cpus: allocation.cpus } : {}),
      ...(overridden.maxRunning ? { maxRunning: allocation.maxRunning } : {}),
    });
    setDraft(initial);
    setOpened(initial);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Mounted all along and opened by `isOpen`, like every other modal here.
  if (!user) return <Modal isOpen={false} onClose={onClose} />;
  const { allocation, overridden, used } = user.sandbox;
  // An empty field shows what it follows: the default, which is the resolved
  // value wherever nothing is overridden.
  const current = draftFrom(allocation);
  const placeholders: Partial<AllocationDraft> = {
    memoryGb: overridden.memoryMb ? 'Default' : `Default: ${current.memoryGb}`,
    cpus: overridden.cpus ? 'Default' : `Default: ${current.cpus}`,
    maxRunning: maxRunningPinned
      ? `Set by the server: ${current.maxRunning}`
      : overridden.maxRunning
        ? 'Default'
        : `Default: ${current.maxRunning}`,
  };

  const run = async (write: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await write();
      onSaved();
      onClose();
    } catch (err) {
      setError(describeRequestError(err, "Couldn't save the allocation."));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const parsed = parseAllocationDraft(draft, { maxRunningPinned });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const patch = changedParts(opened, draft, parsed.value);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    void run(() => adminSetUserSandboxAllocation(user.id, patch));
  };

  return (
    <Modal isOpen onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="admin.allocation.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Sandbox allocation</Heading>
        </ModalHeader>
        <ModalBody scrollEnabled keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
          <VStack space="md">
            <Text size="sm" className="text-foreground">
              {user.email}
            </Text>
            <Text testID="admin.allocation.usage" size="xs" className="text-muted-foreground">
              {`Now: ${allocationSummary(allocation, used)}`}
            </Text>
            <AllocationFields
              draft={draft}
              onChange={(next) => {
                setDraft(next);
                setError(null);
              }}
              testIDPrefix="admin.allocation"
              placeholders={placeholders}
              locked={{ memoryGb: saving, cpus: saving, maxRunning: saving || maxRunningPinned }}
            />
            {maxRunningPinned && (
              <Text size="2xs" className="text-muted-foreground">
                Running at once is set by the SANDBOX_MAX_PER_USER environment variable, for everyone.
              </Text>
            )}
            <Text size="2xs" className="text-muted-foreground">
              Leave a field empty to follow the default. Lowering it pauses nothing; it only refuses their next start.
            </Text>
            {error && (
              <Text testID="admin.allocation.error" size="xs" className="text-destructive">
                {error}
              </Text>
            )}
            <DisconnectedNote testID="admin.allocation.disconnected" what="change this" />
          </VStack>
        </ModalBody>
        <ModalFooter>
          <HStack space="sm" className="flex-wrap justify-end">
            <Button testID="admin.allocation.cancel" size="sm" variant="outline" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID="admin.allocation.reset"
              size="sm"
              variant="outline"
              isDisabled={!reachable || saving || !anyOverridden(overridden)}
              onPress={() => { void run(() => adminClearUserSandboxAllocation(user.id)); }}
            >
              <ButtonText>Use the default</ButtonText>
            </Button>
            <Button testID="admin.allocation.save" size="sm" isDisabled={!reachable || saving} onPress={save}>
              <ButtonText>{saving ? 'Saving…' : 'Save'}</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
