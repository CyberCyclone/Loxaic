import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Plus, ShieldAlert } from 'lucide-react-native';
import { getProviderModels, type InferenceProvider, type ProviderInput } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { ProviderCard } from '@/components/providers/ProviderCard';
import { ProviderModal } from '@/components/providers/ProviderModal';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useProviders } from '@/hooks/useProviders';
import { useToastHelper } from '@/hooks/useToastHelper';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { useSession } from '@/lib/session';

export default function ProvidersScreen() {
  const shell = useShell();
  const { token, isAdmin } = useSession();
  // Null for a non-admin, so the hook never calls a route that would 403 them.
  const { providers, builtin, loading, create, update, remove, test } = useProviders(isAdmin ? token : null);
  const { showToast } = useToastHelper();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<InferenceProvider | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<InferenceProvider | null>(null);
  const [availableModels, setAvailableModels] = useState<{ id: string; display_name: string }[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  /** Asked for when the modal opens on an existing provider: the allowlist
   * editor needs what the provider lists, which only it can answer. */
  // Which request's answer is still wanted. This awaits a *remote* provider —
  // a LAN host that has gone away spends its whole timeout here — so opening
  // provider A, closing it, and opening B let A's list land in B's editor.
  // Nothing on screen tells the two catalogues apart, and ticking boxes from
  // the wrong one saves them as B's allowlist: a server-enforced spending
  // limit made of ids that resolve against neither provider. Every state
  // write below, the spinner included, belongs to the latest request only.
  const modelsRequest = useRef(0);

  const loadModels = useCallback(async (provider: InferenceProvider | null) => {
    const request = ++modelsRequest.current;
    const current = () => modelsRequest.current === request;
    setAvailableModels([]);
    setModelsError(null);
    if (!provider) {
      setLoadingModels(false);
      return;
    }
    setLoadingModels(true);
    try {
      const result = await getProviderModels(provider.id);
      if (!current()) return;
      setAvailableModels(result.models);
      setModelsError(result.error ?? null);
    } catch (err) {
      if (!current()) return;
      setModelsError(err instanceof Error ? err.message : 'Could not reach this provider');
    } finally {
      if (current()) setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    // Closing counts as a new request too, so an answer still in flight when
    // the modal shuts cannot arrive into whatever is opened next.
    void loadModels(modalOpen ? editing : null);
  }, [modalOpen, editing, loadModels]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (provider: InferenceProvider) => {
    setEditing(provider);
    setModalOpen(true);
  };

  const handleSave = async (input: ProviderInput) => {
    if (editing) await update(editing.id, input);
    else await create(input);
  };

  const handleTest = async (provider: InferenceProvider) => {
    setTestingId(provider.id);
    try {
      const result = await test(provider.id);
      if (result.ok) showToast(`Reachable — ${String(result.models ?? 0)} models`);
      else showToast(`Could not reach it: ${result.error ?? 'unknown error'}`, 5000);
    } catch {
      showToast('Could not reach this provider');
    } finally {
      setTestingId(null);
    }
  };

  const body = () => {
    if (!isAdmin) {
      return (
        <VStack space="md" className="flex-1 items-center justify-center p-6">
          <Icon as={ShieldAlert} className="text-muted-foreground" />
          <Text testID="providers.denied" size="sm" className="text-center text-muted-foreground">
            Model providers are set up by an administrator. Whatever they add shows up in your model
            picker, grouped by provider.
          </Text>
        </VStack>
      );
    }

    if (loading && providers.length === 0) {
      return (
        <Box className="flex-1 items-center justify-center">
          <Spinner />
        </Box>
      );
    }

    return (
      <FlatList
        testID="providers.list"
        data={providers}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ItemSeparatorComponent={() => <Box className="h-2" />}
        ListHeaderComponent={
          <VStack space="sm" className="mb-2">
            {builtin && (
              // Described, never editable: an admin needs to see what is
              // already there before deciding whether to add anything, and
              // "set by an environment variable" is the answer to why this
              // screen cannot change it.
              <Box testID="providers.builtin" className="rounded-md border border-border bg-muted/40 p-3">
                <HStack className="items-center justify-between">
                  <Text className="font-medium text-foreground">{builtin.name}</Text>
                  <Text size="2xs" className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    built-in
                  </Text>
                </HStack>
                <Text size="xs" className="mt-0.5 text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                  {builtin.baseUrl}
                </Text>
                <Text size="2xs" className="mt-1 text-muted-foreground">
                  Set by the {builtin.envVar} environment variable, so it cannot be changed here.
                </Text>
              </Box>
            )}
            {providers.length === 0 && (
              <VStack space="xs" className="px-1 pt-2">
                <Text size="sm" className="text-foreground">
                  No other providers yet
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  Add OpenRouter, OpenAI or Anthropic with an API key, or another llama.cpp or LM Studio
                  host on your network. Their models appear in everyone&apos;s picker, grouped under the
                  name you give here.
                </Text>
                <Pressable
                  testID="providers.addFirst"
                  onPress={openCreate}
                  className="mt-1 self-start rounded-full bg-primary px-4 py-2"
                >
                  <Text className="text-primary-foreground">Add your first provider</Text>
                </Pressable>
              </VStack>
            )}
          </VStack>
        }
        renderItem={({ item }) => (
          <ProviderCard
            provider={item}
            testing={testingId === item.id}
            onToggle={(enabled) => { void update(item.id, { enabled }); }}
            onTest={() => { void handleTest(item); }}
            onEdit={() => { openEdit(item); }}
            onDelete={() => { setDeleting(item); }}
          />
        )}
      />
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Model Providers"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
        right={
          isAdmin ? (
            <Button testID="providers.add" size="sm" className="bg-primary" onPress={openCreate}>
              <ButtonIcon as={Plus} className="text-primary-foreground" />
              <ButtonText className="text-primary-foreground">Add</ButtonText>
            </Button>
          ) : undefined
        }
      />

      {body()}

      <ProviderModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); }}
        onSave={handleSave}
        editing={editing}
        availableModels={availableModels}
        modelsError={modelsError}
        loadingModels={loadingModels}
      />
      <WarningConfirmModal
        open={deleting !== null}
        testIDPrefix="providers.deleteConfirm"
        title={`Remove ${deleting?.name ?? ''}?`}
        // What is actually lost, and what is not: the credential goes, and the
        // conversations that used its models keep a reference that no longer
        // resolves rather than quietly answering from a different backend.
        message={
          'Its API key is deleted. Conversations that used its models will ask you to pick a different one — ' +
          'their history is kept. Adding it back under the same name restores those models.'
        }
        confirmLabel="Remove"
        onCancel={() => { setDeleting(null); }}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void remove(target.id);
        }}
      />
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
