import { useState } from 'react';
import { Cpu, RotateCcw, TriangleAlert } from 'lucide-react-native';
import type { LlamaBackend, LocalModelsSettings, LocalRuntimeView } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Input, InputField } from '@/components/ui/input';
import { PresetChips } from '@/components/settings/PresetChips';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { cpuWarning, formatBytes, runtimeHeadline } from '@/lib/localModels';
import { TRUNCATE_TEXT } from '@/lib/truncate';

const BACKENDS: { value: LlamaBackend; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'metal', label: 'Metal' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'rocm', label: 'ROCm' },
  { value: 'cpu', label: 'CPU' },
];

interface RuntimeCardProps {
  runtime: LocalRuntimeView;
  settings: LocalModelsSettings;
  onRestart: () => void;
  onSettings: (patch: {
    backend?: LlamaBackend;
    cpuAcknowledged?: boolean;
    devices?: string[] | null;
    hfToken?: string | null;
  }) => Promise<boolean>;
}

/**
 * The llama.cpp runtime in one line, the way LM Studio shows its runtime:
 * what it found, what it is running on, and — only when asked — the backend
 * and device overrides.
 *
 * CPU is offered, and always behind a warning: one naming the GPU that would
 * go unused when there is one, and a "small models only" one when there is
 * not. Nothing ever lands on the CPU without that confirmation, and a card
 * running on the CPU says so for as long as it does.
 */
export function RuntimeCard({ runtime, settings, onRestart, onSettings }: RuntimeCardProps) {
  const [advanced, setAdvanced] = useState(false);
  const [confirmCpu, setConfirmCpu] = useState(false);
  const [token, setToken] = useState('');
  const warning = cpuWarning(runtime);
  const busy = runtime.state === 'installing' || runtime.state === 'starting' || runtime.state === 'not-installed';
  const progress = runtime.installProgress;
  const pct = progress && progress.totalBytes > 0 ? Math.floor((progress.doneBytes / progress.totalBytes) * 100) : null;
  const pinnedBackend = settings.envOverrides.backend;
  const activeDevices = runtime.activeDevices === 'none' ? [] : runtime.activeDevices;

  const chooseBackend = (backend: LlamaBackend) => {
    if (backend === settings.backend) return;
    if (backend === 'cpu') {
      setConfirmCpu(true);
      return;
    }
    void onSettings({ backend });
  };

  const toggleDevice = (name: string) => {
    const next = activeDevices.includes(name) ? activeDevices.filter((d) => d !== name) : [...activeDevices, name];
    void onSettings({ devices: next.length > 0 ? next : null });
  };

  return (
    <Box testID="localModels.runtime" className="rounded-md border border-border bg-card p-3">
      <HStack className="items-center justify-between">
        <HStack space="sm" className="min-w-0 shrink items-center">
          {busy ? <Spinner size="small" /> : <Icon as={Cpu} size="sm" className="shrink-0 text-muted-foreground" />}
          <VStack className="min-w-0 shrink">
            <Text testID="localModels.runtime.headline" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              {runtimeHeadline(runtime)}
            </Text>
            <Text size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              llama.cpp {runtime.tag}
              {runtime.flavour ? ` · ${runtime.flavour}` : ''}
              {pct !== null ? ` · downloading ${String(pct)}% of ${formatBytes(progress?.totalBytes)}` : ''}
            </Text>
          </VStack>
        </HStack>
        {runtime.mode === 'managed' && (
          <Pressable
            testID="localModels.runtime.restart"
            onPress={onRestart}
            disabled={busy}
            className="shrink-0 flex-row items-center gap-1 p-1"
          >
            <Icon as={RotateCcw} size="xs" className="text-muted-foreground" />
            <Text size="xs" className="text-muted-foreground">
              {runtime.state === 'error' || runtime.state === 'needs-gpu' ? 'Retry' : 'Restart'}
            </Text>
          </Pressable>
        )}
      </HStack>

      {runtime.cpuActive && (
        <HStack testID="localModels.runtime.cpuWarning" space="xs" className="mt-2 items-start rounded-md bg-warning/15 p-2">
          <Icon as={TriangleAlert} size="xs" className="mt-0.5 text-warning" />
          <Text size="xs" className="min-w-0 flex-1 text-foreground">
            {runtime.gpuAvailable
              ? 'Models are running on the CPU although this machine has a GPU. Replies are much slower than they need to be.'
              : 'Models are running on the CPU. Only small models reply at a usable speed.'}
          </Text>
        </HStack>
      )}

      {runtime.reason && (
        <Text testID="localModels.runtime.reason" size="xs" className="mt-2 text-muted-foreground">
          {runtime.reason}
        </Text>
      )}

      {runtime.state === 'needs-gpu' && runtime.mode === 'managed' && !pinnedBackend && (
        <Pressable
          testID="localModels.runtime.useCpu"
          onPress={() => { setConfirmCpu(true); }}
          className="mt-2 self-start rounded-full bg-muted px-3 py-1.5"
        >
          <Text size="sm" className="text-foreground">
            Use the CPU instead…
          </Text>
        </Pressable>
      )}

      {runtime.mode === 'managed' && (
        <Pressable testID="localModels.runtime.advanced" onPress={() => { setAdvanced((a) => !a); }} className="mt-2 self-start py-1">
          <Text size="xs" className="text-primary">
            {advanced ? 'Hide runtime settings' : 'Runtime settings'}
          </Text>
        </Pressable>
      )}

      {advanced && (
        <VStack space="md" className="mt-2 border-t border-border pt-3">
          <VStack space="xs">
            <Text size="xs" className="text-muted-foreground">
              Backend{pinnedBackend ? ' (pinned by LLAMA_BACKEND)' : ''}
            </Text>
            <PresetChips
              chips={BACKENDS.map((b) => ({ value: b.value, label: b.label, key: b.value }))}
              value={settings.backend}
              onChoose={chooseBackend}
              disabled={pinnedBackend}
              testIDPrefix="localModels.runtime.backend"
            />
            <Text size="2xs" className="text-muted-foreground">
              Automatic picks the build for this machine&apos;s GPU and never chooses the CPU.
            </Text>
          </VStack>

          {runtime.devices.length > 0 && !runtime.cpuActive && (
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                GPUs to use
              </Text>
              {runtime.devices.map((d) => {
                const on = activeDevices.includes(d.name);
                return (
                  <Pressable
                    key={d.name}
                    testID={`localModels.runtime.device.${d.name}`}
                    onPress={() => { toggleDevice(d.name); }}
                    className={`flex-row items-center justify-between rounded-md border px-3 py-2 ${on ? 'border-primary bg-primary/10' : 'border-border'}`}
                  >
                    <Text size="sm" className="min-w-0 shrink text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                      {d.description} ({d.name})
                    </Text>
                    <Text size="xs" className="shrink-0 text-muted-foreground">
                      {formatBytes(d.totalBytes)}
                      {on ? ' · in use' : ''}
                    </Text>
                  </Pressable>
                );
              })}
              <Text size="2xs" className="text-muted-foreground">
                By default only GPUs with 4 GB free are used, so a small display card, or one another program has
                filled, does not get part of a model.
              </Text>
            </VStack>
          )}

          <VStack space="xs">
            <Text size="xs" className="text-muted-foreground">
              HuggingFace token{settings.envOverrides.hfToken ? ' (pinned by HF_TOKEN)' : settings.hasHfToken ? ' (set)' : ''}
            </Text>
            <HStack space="sm" className="items-center">
              <Input className="min-w-0 flex-1" isDisabled={settings.envOverrides.hfToken}>
                <InputField
                  testID="localModels.runtime.hfToken"
                  value={token}
                  onChangeText={setToken}
                  placeholder={settings.hasHfToken ? 'Replace the stored token' : 'hf_… (only for gated models)'}
                  secureTextEntry
                  autoCapitalize="none"
                />
              </Input>
              <Pressable
                testID="localModels.runtime.hfToken.save"
                disabled={!token.trim()}
                onPress={() => {
                  void onSettings({ hfToken: token.trim() }).then((ok) => { if (ok) setToken(''); });
                }}
                className="rounded-md bg-primary px-3 py-2"
              >
                <Text size="sm" className="text-primary-foreground">
                  Save
                </Text>
              </Pressable>
              {settings.hasHfToken && !settings.envOverrides.hfToken && (
                <Pressable testID="localModels.runtime.hfToken.remove" onPress={() => { void onSettings({ hfToken: null }); }} className="p-2">
                  <Text size="sm" className="text-destructive">
                    Remove
                  </Text>
                </Pressable>
              )}
            </HStack>
            <Text size="2xs" className="text-muted-foreground">
              Needed only for gated models (Llama, Gemma and similar), after accepting their terms on huggingface.co.
            </Text>
          </VStack>
        </VStack>
      )}

      <WarningConfirmModal
        open={confirmCpu}
        testIDPrefix="localModels.cpuConfirm"
        title={warning.title}
        message={warning.message}
        confirmLabel={warning.confirm}
        onCancel={() => { setConfirmCpu(false); }}
        onConfirm={() => {
          setConfirmCpu(false);
          void onSettings({ backend: 'cpu', cpuAcknowledged: true });
        }}
      />
    </Box>
  );
}
