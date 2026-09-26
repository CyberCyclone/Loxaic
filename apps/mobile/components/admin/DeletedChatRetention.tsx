import { useEffect, useState } from 'react';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useServerReachable } from '@/lib/connection';
import type { ConversationRetentionSettings } from '@loxaic/api-client';

interface DeletedChatRetentionProps {
  settings: ConversationRetentionSettings;
  onChange: (patch: { keepDeleted?: boolean; keepDeletedDays?: number }) => void;
}

/**
 * What this deployment does with a conversation its owner deleted.
 *
 * Both outcomes are spelled out, like AutoCompactToggle's, because neither is
 * guessable from a switch: one of them means an administrator can read a chat
 * its owner believes is gone, and the other means nobody can answer a question
 * about it afterwards. Which is right depends on what the deployment is for,
 * so the card states both and lets the admin choose rather than implying one.
 *
 * Turning it *off* is the destructive direction and is confirmed: everything
 * currently retained and not held is erased by the next sweep, within the
 * hour. That is not obvious from a switch moving to "off".
 */
export function DeletedChatRetention({ settings, onChange }: DeletedChatRetentionProps) {
  const [days, setDays] = useState(String(settings.keepDeletedDays));
  const [confirmOff, setConfirmOff] = useState(false);
  const reachable = useServerReachable();

  // Follow the server when it answers with something else — a rejected value,
  // or another admin's change picked up by a refresh.
  useEffect(() => {
    setDays(String(settings.keepDeletedDays));
  }, [settings.keepDeletedDays]);

  const pinned = settings.envOverrides;
  const parsed = Number(days);
  const daysValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650;
  const daysDirty = daysValid && parsed !== settings.keepDeletedDays;

  return (
    // `shrink-0` is load-bearing: gluestack puts `min-h-0` on every VStack, so
    // in a flex column beside the conversation list this card compressed to
    // nothing instead of taking the height its text needs — its copy rendered
    // straight over the first few rows of the list. The list is the thing that
    // should give way and scroll, not the settings card.
    <VStack space="xs" className="shrink-0 border-b border-border p-4">
      <Text size="xs" className="text-muted-foreground">
        Deleted chats
      </Text>
      <HStack space="sm" className="items-center">
        <Switch
          testID="admin.retention.toggle"
          value={settings.keepDeleted}
          isDisabled={pinned.keepDeleted || !reachable}
          onValueChange={(next) => {
            if (!next) {
              setConfirmOff(true);
              return;
            }
            onChange({ keepDeleted: true });
          }}
        />
        <Text size="sm" className="flex-1 text-foreground">
          Keep deleted chats so an administrator can review them
        </Text>
      </HStack>

      {settings.keepDeleted && (
        <HStack space="sm" className="items-center pt-1">
          <Input className="h-9 w-24" isDisabled={pinned.keepDeletedDays}>
            <InputField
              testID="admin.retention.days"
              value={days}
              onChangeText={setDays}
              keyboardType="number-pad"
              accessibilityLabel="Days to keep deleted chats"
            />
          </Input>
          <Text size="sm" className="text-muted-foreground">
            days, then erased
          </Text>
          {daysDirty && (
            <Button
              testID="admin.retention.save"
              isDisabled={!reachable}
              size="sm"
              variant="outline"
              onPress={() => { onChange({ keepDeletedDays: parsed }); }}
            >
              <ButtonText>Save</ButtonText>
            </Button>
          )}
          {!daysValid && (
            <Text testID="admin.retention.daysError" size="xs" className="text-destructive">
              1–3650
            </Text>
          )}
        </HStack>
      )}

      <VStack space="xs" className="mt-1">
        <Outcome
          active={settings.keepDeleted}
          testID="admin.retention.onCopy"
          label="On"
          body={`Deleting removes a chat for its owner and everyone it was shared with, and its workspace is destroyed — but the messages are kept for ${String(settings.keepDeletedDays)} days, readable by an administrator on this screen, and then erased. Nobody is told their chat is being kept.`}
        />
        <Outcome
          active={!settings.keepDeleted}
          testID="admin.retention.offCopy"
          label="Off"
          body="Deleting erases the messages outright. Nothing can bring the chat back, and nobody can answer a question about it afterwards — which is what the confirmation tells the person before they delete."
        />
      </VStack>

      {(pinned.keepDeleted || pinned.keepDeletedDays) && (
        <Text size="xs" className="text-muted-foreground">
          Set by the DELETED_CHAT_RETENTION_
          {pinned.keepDeleted && pinned.keepDeletedDays
            ? 'ENABLED and DELETED_CHAT_RETENTION_DAYS environment variables'
            : pinned.keepDeleted
              ? 'ENABLED environment variable'
              : 'DAYS environment variable'}
          .
        </Text>
      )}

      <WarningConfirmModal
        open={confirmOff}
        title="Stop keeping deleted chats?"
        message="Every chat currently kept is erased within the hour, unless an administrator has held it. Chats deleted from now on are erased immediately."
        confirmLabel="Stop keeping"
        testIDPrefix="admin.retention.off"
        onCancel={() => { setConfirmOff(false); }}
        onConfirm={() => {
          setConfirmOff(false);
          onChange({ keepDeleted: false });
        }}
      />
    </VStack>
  );
}

/** The branch in force is readable; the other stays visible but dimmed, so the
 * consequence of flipping the switch is on screen before it is flipped. */
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
