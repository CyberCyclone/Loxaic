import { useEffect, useState } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { InferenceProvider, ProviderInput, ProviderPreset } from '@loxaic/api-client';

/**
 * What a preset fills in.
 *
 * A preset is a shortcut, never an identity: it prefills the name, the address
 * and a concurrency that suits the backend, and the admin can change all
 * three. Two rows may share a preset — two OpenRouter keys, or three llama.cpp
 * hosts — which is exactly why the name has to be theirs to choose.
 *
 * `concurrency` is a spend brake as much as a throughput setting: a hosted
 * provider has no single prompt-cache slot to protect, so the reason to hold
 * it at 1 does not apply, but neither does letting an unbounded number of runs
 * bill at once.
 */
const PRESETS: {
  key: ProviderPreset | 'custom';
  label: string;
  name: string;
  baseUrl: string;
  concurrency: number | null;
  hint: string;
}[] = [
  {
    key: 'openrouter',
    label: 'OpenRouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    concurrency: 16,
    hint: 'One key, hundreds of models including Claude and GPT. Key from openrouter.ai/keys.',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    concurrency: 16,
    hint: 'Key from platform.openai.com. OpenAI does not report context windows, so Loxaic will not guess one.',
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    concurrency: 16,
    hint: "Claude through Anthropic's OpenAI-compatible endpoint. Key from console.anthropic.com.",
  },
  {
    key: 'custom',
    label: 'Custom',
    name: '',
    baseUrl: '',
    concurrency: null,
    hint: 'Any OpenAI-compatible server — llama.cpp, LM Studio, vLLM or Ollama, on this machine or another.',
  },
];

interface ProviderModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: ProviderInput) => Promise<unknown>;
  editing: InferenceProvider | null;
  /** Every model the provider lists, for the allowlist editor. Fetched by the
   * screen once a provider exists to ask. */
  availableModels: { id: string; display_name: string }[];
  modelsError: string | null;
  loadingModels: boolean;
}

export function ProviderModal({
  open,
  onClose,
  onSave,
  editing,
  availableModels,
  modelsError,
  loadingModels,
}: ProviderModalProps) {
  const [preset, setPreset] = useState<ProviderPreset | 'custom'>('custom');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [allowlist, setAllowlist] = useState<string[] | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreset(editing?.preset ?? 'custom');
    setName(editing?.name ?? '');
    setBaseUrl(editing?.baseUrl ?? '');
    setConcurrency(editing?.maxConcurrentRuns === null ? '' : String(editing?.maxConcurrentRuns ?? ''));
    setAllowlist(editing?.modelAllowlist ?? null);
    // Never seeded from the row, unlike every other field: no route returns a
    // stored key, so there is nothing to seed it with. Empty means "leave the
    // stored one alone".
    setApiKey('');
    setModelSearch('');
    setManualModel('');
    setError(null);
  }, [open, editing]);

  const applyPreset = (key: ProviderPreset | 'custom') => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setPreset(key);
    // Only fills a field the admin has not already typed into. Picking a
    // preset to fix the URL must not silently rename a provider they named.
    if (!name.trim()) setName(p.name);
    if (!baseUrl.trim()) setBaseUrl(p.baseUrl);
    if (!concurrency && p.concurrency !== null) setConcurrency(String(p.concurrency));
  };

  const hint = PRESETS.find((p) => p.key === preset)?.hint ?? '';
  const insecureWithKey = apiKey.trim().length > 0 && baseUrl.trim().toLowerCase().startsWith('http://');

  const filteredModels = availableModels.filter(
    (m) =>
      m.id.toLowerCase().includes(modelSearch.trim().toLowerCase()) ||
      m.display_name.toLowerCase().includes(modelSearch.trim().toLowerCase()),
  );

  const toggleModel = (id: string) => {
    setAllowlist((prev) => {
      if (prev === null) return [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  };

  const addManualModel = () => {
    const id = manualModel.trim();
    if (!id) return;
    setAllowlist((prev) => (prev === null ? [id] : prev.includes(id) ? prev : [...prev, id]));
    setManualModel('');
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Give this provider a name — it is what users see in the model picker.');
      return;
    }
    if (!baseUrl.trim()) {
      setError('A provider needs a base URL.');
      return;
    }
    let maxConcurrentRuns: number | null = null;
    if (concurrency.trim()) {
      const n = Number(concurrency.trim());
      if (!Number.isInteger(n) || n < 1 || n > 64) {
        setError('Concurrent runs must be a whole number between 1 and 64.');
        return;
      }
      maxConcurrentRuns = n;
    }

    const input: ProviderInput = {
      name: trimmedName,
      baseUrl: baseUrl.trim(),
      preset: preset === 'custom' ? null : preset,
      maxConcurrentRuns,
      modelAllowlist: allowlist && allowlist.length > 0 ? allowlist : null,
    };
    // Absent rather than empty: an empty string would be a key, and sending
    // one would replace a working credential with nothing.
    if (apiKey.trim()) input.apiKey = apiKey.trim();

    setSaving(true);
    setError(null);
    try {
      await onSave(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this provider');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      {/* Both halves, for the same reason McpServerModal needs them: the
          vendored ModalBody hardcodes `scrollEnabled={false}` before its prop
          spread, and ModalContent has no height cap. Without them the
          allowlist editor — the tallest thing here — extends past the
          viewport with no way to scroll to it. */}
      <ModalContent testID="providers.modal.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">{editing ? `Edit ${editing.name}` : 'Add model provider'}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Provider
              </Text>
              <HStack space="xs" className="flex-wrap">
                {PRESETS.map((p) => (
                  <Pressable
                    key={p.key}
                    testID={`providers.modal.preset.${p.key}`}
                    onPress={() => { applyPreset(p.key); }}
                    className={`rounded-md border px-2.5 py-1 ${
                      preset === p.key ? 'border-primary bg-primary' : 'border-border bg-background'
                    }`}
                  >
                    <Text size="xs" className={preset === p.key ? 'text-primary-foreground' : 'text-muted-foreground'}>
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </HStack>
              {hint !== '' && (
                <Text size="2xs" className="text-muted-foreground">
                  {hint}
                </Text>
              )}
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name — what everyone sees as the group heading in the model picker
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="providers.modal.name"
                  value={name}
                  onChangeText={setName}
                  placeholder="Work OpenRouter"
                />
              </Input>
              {editing && (
                // The slug is immutable and invisible in ordinary use, but it
                // is stored in every message that used one of this provider's
                // models — so renaming has to visibly not touch it.
                <Text size="2xs" className="text-muted-foreground">
                  ID: {editing.slug} — fixed, because it is stored with every message that used this provider
                </Text>
              )}
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Base URL
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="providers.modal.baseUrl"
                  value={baseUrl}
                  onChangeText={setBaseUrl}
                  placeholder="http://192.168.1.13:1234/v1"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Input>
              <Text size="2xs" className="text-muted-foreground">
                The API base, including /v1. A plain address gets /v1 added.
              </Text>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                API key
              </Text>
              {/* One masked single-line field, the shape McpCatalogCard uses —
                  not McpServerModal's deliberately-unmasked textarea, which is
                  unmasked only because React Native cannot do secureTextEntry
                  and multiline at once. */}
              <Input className="border-border bg-card">
                <InputField
                  testID="providers.modal.apiKey"
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={editing?.hasApiKey ? 'Stored ••••  — type to replace' : 'sk-…'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
              </Input>
              <Text size="2xs" className="text-muted-foreground">
                {editing?.hasApiKey
                  ? 'A key is stored. It is never shown again — leave this blank to keep it.'
                  : 'Leave blank for a backend that needs no key, such as llama.cpp or LM Studio.'}
              </Text>
              {insecureWithKey && (
                <Text testID="providers.modal.insecureWarning" size="2xs" className="text-warning">
                  This address is plain http, so the key travels unencrypted. Fine on your own machine or
                  LAN; not over the internet.
                </Text>
              )}
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Concurrent runs
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="providers.modal.concurrency"
                  value={concurrency}
                  onChangeText={setConcurrency}
                  placeholder="Follow the backend"
                  keyboardType="number-pad"
                />
              </Input>
              <Text size="2xs" className="text-muted-foreground">
                How many runs may use this provider at once. Blank follows what the backend reports, and
                falls back to one — which is right for a local model, where a second run evicts the first
                one&apos;s cached prompt.
              </Text>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Models
              </Text>
              <HStack space="xs">
                <Pressable
                  testID="providers.modal.allowAll"
                  onPress={() => { setAllowlist(null); }}
                  className={`rounded-md border px-2.5 py-1 ${
                    allowlist === null ? 'border-primary bg-primary' : 'border-border bg-background'
                  }`}
                >
                  <Text size="xs" className={allowlist === null ? 'text-primary-foreground' : 'text-muted-foreground'}>
                    All models
                  </Text>
                </Pressable>
                <Pressable
                  testID="providers.modal.allowSome"
                  onPress={() => { setAllowlist((prev) => prev ?? []); }}
                  className={`rounded-md border px-2.5 py-1 ${
                    allowlist !== null ? 'border-primary bg-primary' : 'border-border bg-background'
                  }`}
                >
                  <Text size="xs" className={allowlist !== null ? 'text-primary-foreground' : 'text-muted-foreground'}>
                    Only these
                  </Text>
                </Pressable>
              </HStack>
              <Text size="2xs" className="text-muted-foreground">
                Every signed-in user can pick any model offered here, and it is billed to this key.
                Restricting the list is enforced on the server, not just hidden in the picker.
              </Text>

              {allowlist !== null && (
                <VStack space="xs" className="mt-1">
                  {!editing ? (
                    <Text size="2xs" className="text-muted-foreground">
                      Save this provider first — then Loxaic can ask it which models it has.
                    </Text>
                  ) : (
                    <>
                      <Input className="border-border bg-card">
                        <InputField
                          testID="providers.modal.modelSearch"
                          value={modelSearch}
                          onChangeText={setModelSearch}
                          placeholder="Search this provider's models..."
                          autoCapitalize="none"
                        />
                      </Input>
                      {loadingModels ? (
                        <Text size="2xs" className="text-muted-foreground">
                          Asking the provider what it has…
                        </Text>
                      ) : modelsError !== null ? (
                        <Text size="2xs" className="text-muted-foreground">
                          {modelsError} — add model ids by hand below instead.
                        </Text>
                      ) : null}
                      {/* Capped: a provider can list hundreds, and this is
                          inside a modal body that is already scrolling. */}
                      {filteredModels.slice(0, 40).map((m) => {
                        const on = allowlist.includes(m.id);
                        return (
                          <Pressable
                            key={m.id}
                            testID={`providers.modal.model.${m.id}`}
                            onPress={() => { toggleModel(m.id); }}
                            className={`flex-row items-center justify-between rounded-md border px-2 py-1.5 ${
                              on ? 'border-primary bg-primary/10' : 'border-border bg-background'
                            }`}
                          >
                            <Text size="xs" className="min-w-0 shrink text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                              {m.id}
                            </Text>
                            <Text size="2xs" className={on ? 'shrink-0 text-primary' : 'shrink-0 text-muted-foreground'}>
                              {on ? 'allowed' : 'add'}
                            </Text>
                          </Pressable>
                        );
                      })}
                      {filteredModels.length > 40 && (
                        <Text size="2xs" className="text-muted-foreground">
                          {filteredModels.length - 40} more — search to narrow
                        </Text>
                      )}
                      {/* Ids the provider does not list can still be allowed:
                          a backend whose /models needs different credentials
                          than its completions endpoint is otherwise unusable,
                          and the allowlist doubles as its catalogue. */}
                      <HStack space="xs" className="items-center">
                        <Box className="min-w-0 flex-1">
                          <Input className="border-border bg-card">
                            <InputField
                              testID="providers.modal.manualModel"
                              value={manualModel}
                              onChangeText={setManualModel}
                              placeholder="Or type a model id"
                              autoCapitalize="none"
                              autoCorrect={false}
                              onSubmitEditing={addManualModel}
                            />
                          </Input>
                        </Box>
                        <Button
                          testID="providers.modal.addModel"
                          size="sm"
                          variant="outline"
                          onPress={addManualModel}
                        >
                          <ButtonText>Add</ButtonText>
                        </Button>
                      </HStack>
                      {allowlist.length > 0 && (
                        <Text testID="providers.modal.allowCount" size="2xs" className="text-muted-foreground">
                          {allowlist.length} allowed: {allowlist.join(', ')}
                        </Text>
                      )}
                    </>
                  )}
                </VStack>
              )}
            </VStack>

            {error !== null && (
              <Text testID="providers.modal.error" size="xs" className="text-destructive">
                {error}
              </Text>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button testID="providers.modal.cancel" variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              testID="providers.modal.save"
              size="sm"
              className="bg-primary"
              onPress={() => { void handleSave(); }}
              isDisabled={!name.trim() || !baseUrl.trim() || saving}
            >
              {saving && <ButtonSpinner />}
              <ButtonText className="text-primary-foreground">
                {editing ? 'Save provider' : 'Add provider'}
              </ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
