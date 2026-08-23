import { Play, History, Pencil, Trash2 } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { humanizeCron } from '@/lib/fixtures/routines';
import type { Routine } from '@shannon/api-client';

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface RoutineCardProps {
  routine: Routine;
  running?: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewHistory: () => void;
}

export function RoutineCard({
  routine,
  running,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onViewHistory,
}: RoutineCardProps) {
  return (
    <Box className="rounded-md border border-border bg-card p-3">
      <HStack className="items-start justify-between">
        <Pressable onPress={onEdit} className="flex-1 pr-2">
          <Text className="font-medium text-foreground" numberOfLines={1}>
            {routine.name}
          </Text>
          <Text size="xs" className="mt-0.5 text-muted-foreground" numberOfLines={2}>
            {routine.prompt}
          </Text>
        </Pressable>
        <Switch value={routine.enabled} onValueChange={onToggle} />
      </HStack>

      <HStack space="xs" className="mt-2 items-center">
        <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
          {humanizeCron(routine.cron)}
        </Text>
        <Text size="2xs" className="text-muted-foreground">
          Last run: {formatTimestamp(routine.lastRunAt)}
        </Text>
      </HStack>

      <HStack space="md" className="mt-3 items-center justify-end border-t border-border pt-2">
        <Pressable onPress={onRunNow} disabled={running} className="flex-row items-center gap-1 p-1">
          {running ? (
            <Spinner size="small" />
          ) : (
            <Icon as={Play} size="xs" className="text-muted-foreground" />
          )}
          <Text size="xs" className="text-muted-foreground">
            Run now
          </Text>
        </Pressable>
        <Pressable onPress={onViewHistory} className="flex-row items-center gap-1 p-1">
          <Icon as={History} size="xs" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">
            History
          </Text>
        </Pressable>
        <Pressable onPress={onEdit} className="p-1">
          <Icon as={Pencil} size="xs" className="text-muted-foreground" />
        </Pressable>
        <Pressable onPress={onDelete} className="p-1">
          <Icon as={Trash2} size="xs" className="text-destructive" />
        </Pressable>
      </HStack>
    </Box>
  );
}
