import { Play, History, Pencil, Trash2 } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { humanizeCron } from '@/lib/fixtures/routines';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { useServerReachable } from '@/lib/connection';
import type { Routine } from '@loxaic/api-client';

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${String(days)}d ago`;
}

interface RoutineCardProps {
  routine: Routine;
  running?: boolean;
  /** What this routine runs on, for display. Null for one written before the
   * field existed — which cannot run at all until a model is chosen. */
  modelLabel: string | null;
  /** The routine has a model and it no longer resolves — its provider was
   * deleted or switched off. A different sentence from never having had one,
   * because the fix is different: this one *was* working. */
  modelUnavailable?: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  /** Opens this routine's chats. The card's main body, because seeing what a
   * routine actually said is what you come to a routine for. */
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewHistory: () => void;
}

export function RoutineCard({
  routine,
  running,
  modelLabel,
  modelUnavailable,
  onToggle,
  onRunNow,
  onOpen,
  onEdit,
  onDelete,
  onViewHistory,
}: RoutineCardProps) {
  // Toggle, Run now and Delete are requests; Edit opens a form that says for
  // itself why it cannot save.
  const reachable = useServerReachable();
  return (
    <Box className="rounded-md border border-border bg-card p-3">
      <HStack className="items-start justify-between">
        {/* Pressing the routine opens its chats — it used to open the edit
            form, which put the settings in front of the thing they configure. */}
        <Pressable testID={`routines.open.${routine.id}`} onPress={onOpen} className="flex-1 pr-2">
          <Text className="font-medium text-foreground" numberOfLines={1}>
            {routine.name}
          </Text>
          <Text size="xs" className="mt-0.5 text-muted-foreground" numberOfLines={2}>
            {routine.prompt}
          </Text>
        </Pressable>
        <Switch
          testID={`routines.toggle.${routine.id}`}
          value={routine.enabled}
          disabled={!reachable}
          onValueChange={onToggle}
        />
      </HStack>

      <HStack space="xs" className="mt-2 flex-wrap items-center">
        <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
          {humanizeCron(routine.cron)}
        </Text>
        {/* Said plainly rather than left to a failed run to explain: this
            routine cannot run at all until someone picks a model. */}
        <Text
          testID={`routines.model.${routine.id}`}
          size="2xs"
          className={
            modelLabel
              ? 'rounded-full bg-muted px-2 py-0.5 text-muted-foreground'
              : 'rounded-full bg-destructive/15 px-2 py-0.5 text-destructive'
          }
          numberOfLines={1}
          style={TRUNCATE_TEXT}
        >
          {modelLabel ?? (modelUnavailable ? 'Model unavailable' : 'No model')}
        </Text>
        <Text testID={`routines.lastRun.${routine.id}`} size="2xs" className="text-muted-foreground">
          Last run: {formatTimestamp(routine.lastRunAt)}
        </Text>
      </HStack>

      <HStack space="md" className="mt-3 items-center justify-end border-t border-border pt-2">
        <Pressable testID={`routines.runNow.${routine.id}`} onPress={onRunNow} disabled={running || !reachable} className={`flex-row items-center gap-1 p-1 ${reachable ? '' : 'opacity-50'}`}>
          {running ? (
            <Spinner size="small" />
          ) : (
            <Icon as={Play} size="xs" className="text-muted-foreground" />
          )}
          <Text size="xs" className="text-muted-foreground">
            Run now
          </Text>
        </Pressable>
        <Pressable testID={`routines.history.${routine.id}`} onPress={onViewHistory} className="flex-row items-center gap-1 p-1">
          <Icon as={History} size="xs" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">
            History
          </Text>
        </Pressable>
        <Pressable testID={`routines.edit.${routine.id}`} onPress={onEdit} className="p-1">
          <Icon as={Pencil} size="xs" className="text-muted-foreground" />
        </Pressable>
        <Pressable testID={`routines.delete.${routine.id}`} onPress={onDelete} disabled={!reachable} className={`p-1 ${reachable ? '' : 'opacity-50'}`}>
          <Icon as={Trash2} size="xs" className="text-destructive" />
        </Pressable>
      </HStack>
    </Box>
  );
}
