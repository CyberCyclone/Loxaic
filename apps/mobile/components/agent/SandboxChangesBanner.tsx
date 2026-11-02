import { useState } from 'react';
import { router } from 'expo-router';
import { RotateCw } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { ImageApiError, restartConversationSandbox } from '@loxaic/api-client';
import type { SandboxChange } from '@loxaic/types';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { RESTART_SANDBOX_NOTE, sandboxChangesText } from '@/lib/sandboxChanges';

interface SandboxChangesBannerProps {
  conversationId: string;
  changes: SandboxChange[];
  /** A run is going, which the server would refuse a restart for. */
  running: boolean;
  /** The sandbox has been replaced: what the banner is about has gone. */
  onRestarted: () => void;
}

/**
 * Says a chat's sandbox was made with older settings, and offers to remake it
 * with today's. A sandbox keeps what it was made with otherwise, so without
 * this a change an admin made looks as if it did nothing.
 */
export function SandboxChangesBanner({ conversationId, changes, running, onRestarted }: SandboxChangesBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<{ text: string; allocation: boolean } | null>(null);
  const reachable = useServerReachable();

  const restart = async () => {
    setRestarting(true);
    setError(null);
    try {
      await restartConversationSandbox(conversationId);
      onRestarted();
    } catch (err) {
      setError(
        err instanceof ImageApiError
          ? { text: err.message, allocation: err.status === 429 }
          : { text: describeRequestError(err, "Couldn't restart the sandbox"), allocation: false },
      );
    } finally {
      setRestarting(false);
    }
  };

  return (
    <VStack testID="agent.sandboxChanges.banner" space="xs" className="border-b border-border bg-warning/10 px-3 py-2">
      <HStack space="sm" className="items-center">
        <Icon as={RotateCw} size="xs" className="text-warning" />
        <VStack className="min-w-0 flex-1">
          <Text size="xs" className="font-medium text-warning">
            This sandbox still has its old settings.
          </Text>
          <Text testID="agent.sandboxChanges.text" size="2xs" className="text-warning/80">
            {sandboxChangesText(changes)}
          </Text>
        </VStack>
        <Button
          testID="agent.sandboxChanges.restart"
          size="sm"
          variant="outline"
          className="shrink-0"
          isDisabled={!reachable || running || restarting}
          onPress={() => { setConfirming(true); }}
        >
          {restarting ? <ButtonSpinner /> : <ButtonText>Restart sandbox</ButtonText>}
        </Button>
      </HStack>
      {error && (
        <HStack space="sm" className="items-center">
          <Text testID="agent.sandboxChanges.error" size="2xs" className="min-w-0 flex-1 shrink text-destructive">
            {error.text}
          </Text>
          {error.allocation && (
            <Button
              testID="agent.sandboxChanges.manage"
              size="sm"
              variant="outline"
              className="shrink-0"
              onPress={() => { router.push('/sandboxes'); }}
            >
              <ButtonText>Manage sandboxes</ButtonText>
            </Button>
          )}
        </HStack>
      )}
      <WarningConfirmModal
        open={confirming}
        title="Restart this sandbox?"
        message={RESTART_SANDBOX_NOTE}
        confirmLabel="Restart"
        testIDPrefix="agent.sandboxChanges.confirm"
        onConfirm={() => {
          setConfirming(false);
          void restart();
        }}
        onCancel={() => { setConfirming(false); }}
      />
    </VStack>
  );
}
