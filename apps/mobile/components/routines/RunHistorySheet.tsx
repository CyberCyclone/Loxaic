import { useEffect, useState } from 'react';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
} from '@/components/ui/actionsheet';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Badge, BadgeText } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import type { Routine, RoutineRun } from '@shannon/api-client';

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running…';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface RunHistorySheetProps {
  routine: Routine | null;
  onClose: () => void;
  getRuns: (id: string) => Promise<RoutineRun[]>;
}

export function RunHistorySheet({ routine, onClose, getRuns }: RunHistorySheetProps) {
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!routine) return;
    setLoading(true);
    getRuns(routine.id)
      .then(setRuns)
      .catch(() => { setRuns([]); })
      .finally(() => { setLoading(false); });
  }, [routine, getRuns]);

  return (
    <Actionsheet isOpen={!!routine} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent className="max-h-[70%]">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        <VStack space="sm" className="w-full p-3">
          <Text className="font-semibold text-foreground">{routine?.name} — Run History</Text>
          {loading ? (
            <Spinner />
          ) : runs.length === 0 ? (
            <Text size="sm" className="text-muted-foreground">
              No runs yet
            </Text>
          ) : (
            runs.map((run) => (
              <HStack key={run.id} className="items-center justify-between border-b border-border py-2">
                <VStack>
                  <Text size="sm" className="text-foreground">
                    {new Date(run.startedAt).toLocaleString()}
                  </Text>
                  <Text size="2xs" className="text-muted-foreground">
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </Text>
                </VStack>
                <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>
                  <BadgeText className="normal-case">{run.status}</BadgeText>
                </Badge>
              </HStack>
            ))
          )}
        </VStack>
      </ActionsheetContent>
    </Actionsheet>
  );
}
