import { useState } from 'react';
import { ScrollView, type DimensionValue } from 'react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useSandboxAllocation } from '@/hooks/useSandboxAllocation';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import {
  allocationBars,
  allocationSource,
  orderSandboxes,
  roomForAnother,
  rowAction,
  rowSize,
  type AllocationBar,
} from '@/lib/sandboxAllocation';
import type { AllocatedSandbox } from '@loxaic/api-client';

/**
 * A person's sandbox allocation and what fills it (#254): their running
 * sandboxes' memory, CPUs and count against what they may hold, and a Pause
 * on each one no run is using. Where a chat refused for a full allocation
 * sends them (the tool card's Manage sandboxes), and reachable from Settings.
 * Nothing here is paused for them; they choose.
 */
export default function SandboxesScreen() {
  const shell = useShell();
  const { token } = useSession();
  const reachable = useServerReachable();
  const { data, loading, loadError, pausing, refresh, pause } = useSandboxAllocation(token);
  const [confirming, setConfirming] = useState<AllocatedSandbox | null>(null);

  const body = () => {
    if (loading && !data) {
      return (
        <Box className="flex-1 items-center justify-center p-6">
          <Spinner />
        </Box>
      );
    }
    if (!data) {
      return (
        <VStack space="sm" className="p-4">
          <Text testID="sandboxes.loadError" size="sm" className="text-muted-foreground">
            {`Couldn't load your sandboxes: ${loadError ?? 'no answer from the server.'}`}
          </Text>
          <Button testID="sandboxes.retry" size="sm" variant="outline" className="self-start" isDisabled={!reachable} onPress={() => { void refresh(); }}>
            <ButtonText>Try again</ButtonText>
          </Button>
        </VStack>
      );
    }
    const rows = orderSandboxes(data.sandboxes);
    return (
      <VStack space="lg" className="p-4">
        <VStack space="md">
          {allocationBars(data.allocation, data.used).map((bar) => (
            <UsageBar key={bar.key} bar={bar} />
          ))}
          <Text testID="sandboxes.source" size="xs" className="text-muted-foreground">
            {allocationSource(data.overridden)}
          </Text>
          {!roomForAnother(data.allocation, data.used) && (
            <Text testID="sandboxes.full" size="sm" className="text-warning">
              Your allocation is full. Pause a sandbox to start another, or ask an administrator to raise it.
            </Text>
          )}
        </VStack>

        <VStack space="sm">
          <Text size="xs" className="text-muted-foreground">
            Your sandboxes
          </Text>
          {rows.length === 0 ? (
            <Text testID="sandboxes.empty" size="sm" className="text-muted-foreground">
              No sandboxes yet. One starts the first time an agent runs a command in a chat.
            </Text>
          ) : (
            rows.map((row) => (
              <SandboxRowView
                key={row.id}
                row={row}
                pausing={pausing === row.id}
                disabled={!reachable || pausing !== null}
                onPause={() => { setConfirming(row); }}
              />
            ))
          )}
          <Text size="2xs" className="text-muted-foreground">
            A paused sandbox keeps its files and holds none of your allocation. The next message in its chat starts it
            again, if there is room.
          </Text>
        </VStack>
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Sandboxes" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView className="flex-1">{body()}</ScrollView>
      <WarningConfirmModal
        open={confirming !== null}
        title="Pause this sandbox?"
        message="Pausing closes its open terminals and stops anything running in it. Its files are kept, and the next message in its chat starts it again."
        confirmLabel="Pause"
        testIDPrefix="sandboxes.pauseConfirm"
        onConfirm={() => {
          const row = confirming;
          setConfirming(null);
          if (row) void pause(row.id);
        }}
        onCancel={() => { setConfirming(null); }}
      />
    </VStack>
  );
}

function UsageBar({ bar }: { bar: AllocationBar }) {
  return (
    <VStack space="xs">
      <HStack className="items-baseline justify-between">
        <Text size="sm" className="text-foreground">
          {bar.label}
        </Text>
        <Text testID={`sandboxes.bar.${bar.key}`} size="sm" className={bar.full ? 'text-warning' : 'text-muted-foreground'}>
          {bar.value}
        </Text>
      </HStack>
      <Box className="h-2 overflow-hidden rounded-full bg-muted">
        <Box
          className={`h-2 rounded-full ${bar.full ? 'bg-warning' : 'bg-primary'}`}
          style={{ width: `${String(Math.round(bar.fraction * 100))}%` as DimensionValue }}
        />
      </Box>
    </VStack>
  );
}

function SandboxRowView({
  row,
  pausing,
  disabled,
  onPause,
}: {
  row: AllocatedSandbox;
  pausing: boolean;
  disabled: boolean;
  onPause: () => void;
}) {
  const action = rowAction(row);
  return (
    <HStack testID={`sandboxes.row.${row.id}`} space="sm" className="items-center rounded-lg border border-border bg-card p-3">
      <VStack className="min-w-0 flex-1 shrink">
        <Text testID={`sandboxes.row.${row.id}.title`} size="sm" className="text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
          {row.title ?? 'A sandbox with no chat'}
        </Text>
        <Text size="2xs" className="text-muted-foreground">
          {rowSize(row)}
        </Text>
      </VStack>
      {action.kind === 'pause' ? (
        <Button testID={`sandboxes.row.${row.id}.pause`} size="sm" variant="outline" className="shrink-0" isDisabled={disabled} onPress={onPause}>
          {pausing ? <Spinner size="small" /> : <ButtonText>Pause</ButtonText>}
        </Button>
      ) : (
        <Text testID={`sandboxes.row.${row.id}.status`} size="xs" className="shrink-0 text-muted-foreground">
          {action.kind === 'busy' ? 'Running a task' : action.kind === 'paused' ? 'Paused' : 'Running'}
        </Text>
      )}
    </HStack>
  );
}
