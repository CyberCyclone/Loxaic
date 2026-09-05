import { CircleCheck, CircleAlert } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { SandboxMode } from '@loxaic/api-client';

interface SandboxStatusCardProps {
  mode: SandboxMode;
  available: boolean;
  reason?: string;
  /** Shown only when unavailable — the two ways out, per the ticket's
   * "no-engine UX: a path to either fix". Omitted for the read-only,
   * non-admin view, which can't act on either. */
  showFixes?: boolean;
}

export function SandboxStatusCard({ mode, available, reason, showFixes }: SandboxStatusCardProps) {
  return (
    <Box testID="sandbox.status" className="rounded-md border border-border bg-card p-3">
      <HStack space="xs" className="items-center">
        <Icon
          as={available ? CircleCheck : CircleAlert}
          size="sm"
          className={available ? 'text-success' : 'text-destructive'}
        />
        <VStack className="flex-1">
          <Text size="sm" className="text-foreground">
            {available ? `Agent sandbox available (${mode})` : `Agent sandbox unavailable (${mode})`}
          </Text>
          {reason && (
            <Text testID="sandbox.status.reason" size="xs" className="text-muted-foreground">
              {reason}
            </Text>
          )}
        </VStack>
      </HStack>
      {showFixes && !available && mode !== 'off' && (
        <VStack space="xs" className="mt-3 border-t border-border pt-2">
          <Text size="xs" className="text-muted-foreground">
            Install or start Docker or Podman, or ask an admin to switch to host mode below.
          </Text>
        </VStack>
      )}
    </Box>
  );
}
