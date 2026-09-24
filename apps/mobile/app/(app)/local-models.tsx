import { useState } from 'react';
import { FlatList } from 'react-native';
import { HardDrive, ShieldAlert } from 'lucide-react-native';
import type { LocalModel } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { RuntimeCard } from '@/components/localModels/RuntimeCard';
import { InstalledRow } from '@/components/localModels/InstalledRow';
import { DiscoverPanel } from '@/components/localModels/DiscoverPanel';
import { RepoDetailsModal } from '@/components/localModels/RepoDetailsModal';
import { ModelSettingsModal } from '@/components/localModels/ModelSettingsModal';
import { useLocalModels } from '@/hooks/useLocalModels';
import { formatBytes } from '@/lib/localModels';
import { useSession } from '@/lib/session';

type Tab = 'installed' | 'discover';

/**
 * Local models: the llama.cpp runtime this server runs, the models an admin
 * downloaded from HuggingFace, and which of them every user may pick.
 *
 * Admin-only on the server; a non-admin who reaches the route is told what the
 * screen is for instead of being shown a 403.
 */
export default function LocalModelsScreen() {
  const shell = useShell();
  const { token, isAdmin } = useSession();
  const lm = useLocalModels(isAdmin ? token : null);
  const [tab, setTab] = useState<Tab>('installed');
  const [detailsRepo, setDetailsRepo] = useState<string | null>(null);
  // A snapshot taken when the sheet opens, not the polled row: the poll hands
  // back a new object every second while something downloads, and the sheet
  // resets its draft whenever its model changes.
  const [editing, setEditing] = useState<LocalModel | null>(null);
  const [cancelling, setCancelling] = useState<LocalModel | null>(null);
  const [deleting, setDeleting] = useState<LocalModel | null>(null);

  const body = () => {
    if (!isAdmin) {
      return (
        <VStack space="md" className="flex-1 items-center justify-center p-6">
          <Icon as={ShieldAlert} className="text-muted-foreground" />
          <Text testID="localModels.denied" size="sm" className="text-center text-muted-foreground">
            Local models are downloaded and set up by an administrator. The ones they enable appear in your model
            picker under Built-in.
          </Text>
        </VStack>
      );
    }
    const view = lm.view;
    if (!view) {
      return (
        <Box className="flex-1 items-center justify-center">
          {lm.error ? (
            <Text size="sm" className="text-destructive">
              {lm.error}
            </Text>
          ) : (
            <Spinner />
          )}
        </Box>
      );
    }

    const header = (
      <VStack space="sm" className="mb-2">
        <RuntimeCard
          runtime={view.runtime}
          settings={view.settings}
          onRestart={() => { void lm.restart(); }}
          onSettings={lm.updateSettings}
        />
        <HStack space="xs" className="items-center">
          {(['installed', 'discover'] as const).map((t) => (
            <Pressable
              key={t}
              testID={`localModels.tab.${t}`}
              onPress={() => { setTab(t); }}
              className={`rounded-full px-3 py-1.5 ${tab === t ? 'bg-primary/15' : 'bg-muted'}`}
            >
              <Text size="sm" className={tab === t ? 'text-primary' : 'text-muted-foreground'}>
                {t === 'installed' ? `Downloaded (${String(view.models.length)})` : 'Discover'}
              </Text>
            </Pressable>
          ))}
          {view.freeDiskBytes !== null && (
            <HStack space="xs" className="ml-auto items-center">
              <Icon as={HardDrive} size="2xs" className="text-muted-foreground" />
              <Text testID="localModels.disk" size="2xs" className="text-muted-foreground">
                {formatBytes(view.freeDiskBytes)} free
              </Text>
            </HStack>
          )}
        </HStack>
      </VStack>
    );

    if (tab === 'discover') {
      return (
        <VStack className="flex-1">
          <Box className="px-3 pt-3">{header}</Box>
          <Box className="min-h-0 flex-1">
            <DiscoverPanel onOpen={setDetailsRepo} />
          </Box>
        </VStack>
      );
    }

    return (
      <FlatList
        testID="localModels.list"
        data={view.models}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListHeaderComponent={
          <VStack>
            {header}
            {view.models.length === 0 && (
              <VStack space="xs" className="px-1 pt-2">
                <Text size="sm" className="text-foreground">
                  No models yet
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  Find one on HuggingFace and download it. Once it finishes, switch it on to offer it to everyone.
                </Text>
                <Pressable
                  testID="localModels.discoverFirst"
                  onPress={() => { setTab('discover'); }}
                  className="mt-1 self-start rounded-full bg-primary px-4 py-2"
                >
                  <Text className="text-primary-foreground">Find a model</Text>
                </Pressable>
              </VStack>
            )}
          </VStack>
        }
        renderItem={({ item }) => (
          <InstalledRow
            model={item}
            onToggle={(enabled) => { void lm.update(item.id, { enabled }); }}
            onPause={() => { void lm.pause(item.id); }}
            onResume={() => { void lm.resume(item.id); }}
            onCancel={() => { setCancelling(item); }}
            onDelete={() => { setDeleting(item); }}
            onSettings={() => { setEditing(item); }}
          />
        )}
      />
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Local Models" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      {body()}

      <RepoDetailsModal
        repo={detailsRepo}
        onClose={() => { setDetailsRepo(null); }}
        onDownload={async (input) => {
          const row = await lm.download(input);
          if (row) {
            setDetailsRepo(null);
            setTab('installed');
          }
        }}
      />
      <ModelSettingsModal
        model={editing}
        specs={lm.view?.settingSpecs ?? []}
        onClose={() => { setEditing(null); }}
        onSave={(id, patch) => lm.update(id, patch)}
      />
      <WarningConfirmModal
        open={cancelling !== null}
        testIDPrefix="localModels.cancelConfirm"
        title={`Cancel ${cancelling?.displayName ?? ''}?`}
        message="The download stops and what has been downloaded so far is deleted. Pause it instead to finish later."
        confirmLabel="Cancel download"
        onCancel={() => { setCancelling(null); }}
        onConfirm={() => {
          const target = cancelling;
          setCancelling(null);
          if (target) void lm.cancel(target.id);
        }}
      />
      <WarningConfirmModal
        open={deleting !== null}
        testIDPrefix="localModels.deleteConfirm"
        title={`Delete ${deleting?.displayName ?? ''}?`}
        message={
          `This frees ${formatBytes(deleting?.sizeBytes)}. ` +
          (deleting?.enabled
            ? 'It disappears from everyone’s model picker, and conversations that used it will ask for another model. '
            : '') +
          'Downloading it again later starts from scratch.'
        }
        confirmLabel="Delete"
        onCancel={() => { setDeleting(null); }}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void lm.remove(target.id);
        }}
      />
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
