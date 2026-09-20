import { useCallback, useState } from 'react';
import { FlatList } from 'react-native';
import { useRouter } from 'expo-router';
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
import { ModelModal } from '@/components/settings/ModelModal';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useRoutines } from '@/hooks/useRoutines';
import { useModels } from '@/hooks/useModels';
import { useRecentModels } from '@/hooks/useRecentModels';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSettings } from '@/hooks/useSettings';
import { useToastHelper } from '@/hooks/useToastHelper';
import { deleteRoutineMessage } from '@/lib/deleteMessage';
import { pickSelectedModel } from '@/lib/selectModel';
import { useSession } from '@/lib/session';
import { getRoutineChatCount, type Routine } from '@loxaic/api-client';

export default function RoutinesScreen() {
  const shell = useShell();
  const router = useRouter();
  const { token } = useSession();
  const { routines, loading, create, update, toggle, remove, runNow } = useRoutines(token);
  const { models, loading: modelsLoading, error: modelsError, refresh: refreshModels, defaultModel, getName, isKnown } =
    useModels(token);
  const { recentModels, refreshRecentModels } = useRecentModels(token);
  const { config } = useServerConfig();
  const [settings] = useSettings();
  const { showToast } = useToastHelper();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  // The routine's model while the form is open. Held here rather than in the
  // modal so the picker can render beside it instead of on top of it.
  const [formModel, setFormModel] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  /**
   * Which routine the confirm dialog is about, and how many chats it holds.
   *
   * The count is fetched when the dialog opens rather than carried on the row:
   * it is the number the sentence turns on, and "delete this routine" reads
   * very differently against nothing and against forty conversations.
   */
  const [deleting, setDeleting] = useState<{ routine: Routine; chats: number | null } | null>(null);

  /**
   * Whether this routine's stored model still resolves. Only a *loaded* list
   * can say no: before it arrives `isKnown` is false for everything, and
   * judging then would flash every card red on each visit.
   */
  const modelsLoaded = models.length > 0 || (!modelsLoading && !modelsError);
  const isUnavailable = useCallback(
    (model: string | null) => model !== null && modelsLoaded && !isKnown(model),
    [isKnown, modelsLoaded],
  );

  /**
   * What this model is called, or null when there is nothing usable to name —
   * a routine that never had one, or one whose provider has since been deleted.
   *
   * The second case used to fall through to the raw reference, which rendered
   * `myprovider::llama-3` in a neutral badge and as a chosen model in the form:
   * the warning suppressed in exactly the case it matters most, since every
   * run of that routine fails. The raw ref is shown only while the list is
   * still loading, when it is the best available name rather than a verdict.
   */
  const labelFor = useCallback(
    (model: string | null) => {
      if (!model) return null;
      if (isKnown(model)) return getName(model);
      return modelsLoaded ? null : model;
    },
    [getName, isKnown, modelsLoaded],
  );

  const openCreate = () => {
    setEditing(null);
    // A new routine opens on the same model the chat composer would offer, so
    // the common case is one tap — but it is shown, not implied, because the
    // server will never substitute another one for it.
    setFormModel(
      pickSelectedModel({
        prefModel: undefined,
        hasConversation: false,
        pendingModel: null,
        recentModels,
        modelsLoaded: models.length > 0,
        isKnown,
        defaultModelId: defaultModel?.id,
      }) || null,
    );
    setModalOpen(true);
  };

  const openEdit = (routine: Routine) => {
    setEditing(routine);
    // Exactly what is stored, including null: a routine written before this
    // field existed opens with nothing chosen and cannot be saved until one
    // is, rather than being silently given a model nobody picked for it.
    // A model that no longer resolves opens as nothing chosen too: saving it
    // back would only be refused by the server, and showing it as the current
    // choice hides the one thing the person has come here to fix.
    setFormModel(isUnavailable(routine.model) ? null : routine.model);
    setModalOpen(true);
  };

  const handleSave = async (input: { name: string; cron: string; prompt: string; model: string }) => {
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
    } catch (err) {
      showToast(`Could not run: ${err instanceof Error ? err.message : String(err)}`, 4000);
    } finally {
      setRunningId(null);
    }
  };

  const openDelete = (routine: Routine) => {
    setDeleting({ routine, chats: null });
    // The real count, not the length of the history list's 50-row page.
    getRoutineChatCount(routine.id)
      .then((n) => {
        // Only if the dialog is still about this routine: the fetch is
        // asynchronous and the user may have cancelled and opened another.
        setDeleting((prev) => (prev?.routine.id === routine.id ? { ...prev, chats: n } : prev));
      })
      // Left null on failure, which the message reads as "unknown" and says so
      // — never as zero.
      .catch(() => undefined);
  };

  // `undefined` while the config is still loading, which the message treats as
  // "we were not told" and claims neither outcome — same rule as the chat
  // delete dialog, for the same reason.
  const retentionDays = config ? config.deletedChatRetentionDays : undefined;

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Routines"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
        right={
          <Button testID="routines.new" size="sm" className="bg-primary" onPress={openCreate}>
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
          <Pressable testID="routines.empty.create" onPress={openCreate} className="rounded-full bg-primary px-4 py-2">
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
              modelLabel={labelFor(item.model)}
              modelUnavailable={isUnavailable(item.model)}
              onToggle={(enabled) => { void toggle(item.id, enabled); }}
              onRunNow={() => { void handleRunNow(item.id); }}
              onOpen={() => { router.push(`/routines/${item.id}`); }}
              onEdit={() => { openEdit(item); }}
              onDelete={() => { openDelete(item); }}
              // The history list lives on the routine's own chat screen now,
              // where a row opens the run it names.
              onViewHistory={() => { router.push(`/routines/${item.id}?history=1`); }}
            />
          )}
        />
      )}

      <RoutineModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); }}
        onSave={handleSave}
        editing={editing}
        model={formModel}
        modelLabel={labelFor(formModel)}
        onOpenModelPicker={() => { setModelPickerOpen(true); }}
      />

      {/* A sibling of the routine form, not a child: nothing else in this app
          stacks one modal on another. */}
      <ModelModal
        open={modelPickerOpen}
        onClose={() => { setModelPickerOpen(false); }}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        onRefresh={() => {
          void refreshModels();
          void refreshRecentModels();
        }}
        selectedModel={formModel ?? ''}
        recentModels={recentModels}
        onSelect={(id) => {
          setFormModel(id);
          setModelPickerOpen(false);
        }}
        // A routine has no per-conversation thinking level to set: its runs
        // are started by the server, which reads no such preference. So the
        // row is hidden rather than left there doing nothing.
        thinkingLevel={settings.defaultThinkingLevel}
        onThinkingLevel={() => undefined}
        hideThinking
        onOpenSettings={() => {
          setModelPickerOpen(false);
          shell.openSettings();
        }}
      />

      <WarningConfirmModal
        open={deleting !== null}
        title="Delete routine?"
        message={
          deleting
            ? deleteRoutineMessage(deleting.routine.name, deleting.chats, retentionDays)
            : ''
        }
        confirmLabel="Delete routine"
        testIDPrefix="routines.deleteConfirm"
        onConfirm={() => {
          const target = deleting?.routine.id;
          setDeleting(null);
          if (target) void remove(target);
        }}
        onCancel={() => { setDeleting(null); }}
      />
    </VStack>
  );
}
