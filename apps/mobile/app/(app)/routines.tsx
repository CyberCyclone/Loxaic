import { useState } from 'react';
import { FlatList } from 'react-native';
import { Plus } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { RoutineCard } from '@/components/routines/RoutineCard';
import { RoutineModal } from '@/components/routines/RoutineModal';
import { RunHistorySheet } from '@/components/routines/RunHistorySheet';
import { useRoutines } from '@/hooks/useRoutines';
import { useSession } from '@/lib/session';
import type { Routine } from '@shannon/api-client';

export default function RoutinesScreen() {
  const shell = useShell();
  const { token } = useSession();
  const { routines, loading, create, update, toggle, remove, runNow, getRuns } = useRoutines(token);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [historyFor, setHistoryFor] = useState<Routine | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (routine: Routine) => {
    setEditing(routine);
    setModalOpen(true);
  };

  const handleSave = async (input: { name: string; cron: string; prompt: string }) => {
    if (editing) {
      await update(editing.id, input);
    } else {
      await create(input);
    }
  };

  const handleRunNow = async (id: string) => {
    setRunningId(id);
    try {
      await runNow(id);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Routines"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
        right={
          <Button size="sm" className="bg-primary" onPress={openCreate}>
            <ButtonIcon as={Plus} className="text-primary-foreground" />
            <ButtonText className="text-primary-foreground">New</ButtonText>
          </Button>
        }
      />

      {loading && routines.length === 0 ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner />
        </Box>
      ) : routines.length === 0 ? (
        <Box className="flex-1 items-center justify-center p-6">
          <Text className="mb-2 text-center text-foreground">No routines yet</Text>
          <Text size="sm" className="mb-4 text-center text-muted-foreground">
            Schedule recurring agent runs — daily summaries, code reviews, health checks.
          </Text>
          <Pressable onPress={openCreate} className="rounded-full bg-primary px-4 py-2">
            <Text className="text-primary-foreground">Create your first routine</Text>
          </Pressable>
        </Box>
      ) : (
        <FlatList
          data={routines}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          ItemSeparatorComponent={() => <Box className="h-2" />}
          renderItem={({ item }) => (
            <RoutineCard
              routine={item}
              running={runningId === item.id}
              onToggle={(enabled) => { void toggle(item.id, enabled); }}
              onRunNow={() => { void handleRunNow(item.id); }}
              onEdit={() => { openEdit(item); }}
              onDelete={() => { void remove(item.id); }}
              onViewHistory={() => { setHistoryFor(item); }}
            />
          )}
        />
      )}

      <RoutineModal open={modalOpen} onClose={() => { setModalOpen(false); }} onSave={handleSave} editing={editing} />
      <RunHistorySheet routine={historyFor} onClose={() => { setHistoryFor(null); }} getRuns={getRuns} />
    </VStack>
  );
}
