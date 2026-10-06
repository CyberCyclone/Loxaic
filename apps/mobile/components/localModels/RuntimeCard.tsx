import { useEffect, useRef, useState } from 'react';
import { Cpu, RotateCcw, TriangleAlert } from 'lucide-react-native';
import type { ExtraOption, LlamaBackend, LocalModel, LocalModelsSettings, LocalRuntimeView } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Input, InputField } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PresetChips } from '@/components/settings/PresetChips';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { Button, ButtonText } from '@/components/ui/button';
import { ExtraOptionsEditor } from './ExtraOptionsEditor';
import { useLlamaOptions } from '@/hooks/useLlamaOptions';
import { rowProblems, rowsToSave, sameOptions, type OptionRow } from '@/lib/extraOptions';
import { cpuWarning, formatBytes, restartHeadline, runtimeHeadline } from '@/lib/localModels';
import { bundledNewerNote, changeVersionControl, offersRevert, versionLabel } from '@/lib/runtimeVersions';
import { useServerReachable } from '@/lib/connection';
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
  /** The installed models, for a restart's "loading X (1 of 2)". */
  models: LocalModel[];
  onRestart: () => void;
  onSettings: (patch: {
    backend?: LlamaBackend;
    cpuAcknowledged?: boolean;
    devices?: string[] | null;
    hfToken?: string | null;
    extraOptions?: ExtraOption[];
  }) => Promise<boolean>;
  /** Open the version picker. */
  onChangeVersion: () => void;
  /** Back to the bundled llama.cpp, when the chosen one will not start. */
  onRevertVersion: () => void;
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
export function RuntimeCard({ runtime, settings, models, onRestart, onSettings, onChangeVersion, onRevertVersion }: RuntimeCardProps) {
  const [advanced, setAdvanced] = useState(false);
  const [confirmCpu, setConfirmCpu] = useState(false);
  const [token, setToken] = useState('');
  const warning = cpuWarning(runtime);
  const restarting = Boolean(runtime.restart);
  const busy = restarting || runtime.state === 'installing' || runtime.state === 'starting' || runtime.state === 'not-installed';
  // Ticks the elapsed time while a restart is under way, and only then.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!restarting) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [restarting]);
  const headline = restartHeadline(runtime, models, now) ?? runtimeHeadline(runtime);
  const progress = runtime.installProgress;
  const pct = progress && progress.totalBytes > 0 ? Math.floor((progress.doneBytes / progress.totalBytes) * 100) : null;
  const pinnedBackend = settings.envOverrides.backend;
  // Every control below saves on the server.
  const reachable = useServerReachable();
  const activeDevices = runtime.activeDevices === 'none' ? [] : runtime.activeDevices;
  const versionControl = changeVersionControl(runtime, settings);
  const newerNote = bundledNewerNote(runtime);
  // A third-party build runs on the backend it was made for.
  const customChosen = runtime.version?.kind === 'custom';

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
              {headline}
            </Text>
            <Text testID="localModels.runtime.version" size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              llama.cpp {versionLabel(runtime)}
              {runtime.flavour ? ` · ${runtime.flavour}` : ''}
              {pct !== null ? ` · downloading ${String(pct)}% of ${formatBytes(progress?.totalBytes)}` : ''}
            </Text>
          </VStack>
        </HStack>
        {runtime.mode === 'managed' && (
          <Pressable
            testID="localModels.runtime.restart"
            onPress={onRestart}
            disabled={busy || !reachable}
            className="shrink-0 flex-row items-center gap-1 p-1"
          >
            <Icon as={RotateCcw} size="xs" className="text-muted-foreground" />
            <Text testID={restarting ? 'localModels.runtime.restarting' : undefined} size="xs" className="text-muted-foreground">
              {restarting ? 'Restarting…' : runtime.state === 'error' || runtime.state === 'needs-gpu' ? 'Retry' : 'Restart'}
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

      {offersRevert(runtime) && (
        <Pressable
          testID="localModels.runtime.revert"
          disabled={!reachable}
          onPress={onRevertVersion}
          className="mt-2 self-start rounded-full bg-primary px-3 py-1.5"
        >
          <Text testID="localModels.runtime.revert.label" size="sm" className="text-primary-foreground">
            Switch back to the bundled version ({runtime.version?.bundledTag})
          </Text>
        </Pressable>
      )}

      {newerNote && (
        <Text testID="localModels.runtime.bundledNewer" size="xs" className="mt-2 text-muted-foreground">
          {newerNote}
        </Text>
      )}

      {runtime.state === 'needs-gpu' && runtime.mode === 'managed' && !pinnedBackend && (
        <Pressable
          testID="localModels.runtime.useCpu"
          disabled={!reachable}
          onPress={() => { setConfirmCpu(true); }}
          className="mt-2 self-start rounded-full bg-muted px-3 py-1.5"
        >
          <Text size="sm" className="text-foreground">
            Use the CPU instead…
          </Text>
        </Pressable>
      )}

      {runtime.mode === 'managed' && (
        <HStack space="lg" className="mt-2 flex-wrap items-center">
          <Pressable testID="localModels.runtime.advanced" onPress={() => { setAdvanced((a) => !a); }} className="py-1">
            <Text size="xs" className="text-primary">
              {advanced ? 'Hide runtime settings' : 'Runtime settings'}
            </Text>
          </Pressable>
          {versionControl.show && (
            <Pressable
              testID="localModels.runtime.changeVersion"
              disabled={versionControl.disabled}
              onPress={onChangeVersion}
              className="py-1"
            >
              <Text size="xs" className={versionControl.disabled ? 'text-muted-foreground' : 'text-primary'}>
                Change version
              </Text>
            </Pressable>
          )}
        </HStack>
      )}
      {versionControl.note && (
        <Text testID="localModels.runtime.versionNote" size="2xs" className="mt-1 text-muted-foreground">
          {versionControl.note}
        </Text>
      )}

      {advanced && (
        <VStack space="md" className="mt-2 border-t border-border pt-3">
          <VStack space="xs">
            <Text size="xs" className="text-muted-foreground">
              Backend{pinnedBackend ? ' (pinned by LLAMA_BACKEND)' : ''}
            </Text>
            {customChosen && (
              <Text testID="localModels.runtime.backendNote" size="2xs" className="text-muted-foreground">
                The third-party build in use runs on the backend it was built for. This choice applies again once an
                official version is chosen.
              </Text>
            )}
            <PresetChips
              chips={BACKENDS.map((b) => ({ value: b.value, label: b.label, key: b.value }))}
              value={settings.backend}
              onChoose={chooseBackend}
              disabled={pinnedBackend || !reachable}
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
                  <HStack
                    key={d.name}
                    space="sm"
                    className="items-center rounded-md border border-border px-3 py-2"
                  >
                    <Switch
                      testID={`localModels.runtime.device.${d.name}`}
                      value={on}
                      isDisabled={!reachable}
                      onValueChange={() => { toggleDevice(d.name); }}
                      accessibilityLabel={`Use ${d.description} (${d.name})`}
                    />
                    <Text size="sm" className="min-w-0 flex-1 shrink text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                      {d.description} ({d.name})
                    </Text>
                    {/* Free first: it is what a model can actually use. The
                        card's size alone read as "60 GB across two GPUs" on a
                        machine where another program held most of one. */}
                    <Text testID={`localModels.runtime.device.${d.name}.memory`} size="xs" className="shrink-0 text-muted-foreground">
                      {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
                    </Text>
                  </HStack>
                );
              })}
              <Text size="2xs" className="text-muted-foreground">
                By default only GPUs with 4 GB free are used, so a small display card, or one another program has
                filled, does not get part of a model. Changing this restarts the runtime, which unloads every model.
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
                disabled={!token.trim() || !reachable}
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
                <Pressable testID="localModels.runtime.hfToken.remove" disabled={!reachable} onPress={() => { void onSettings({ hfToken: null }); }} className="p-2">
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

          <RouterOptions runtime={runtime} reachable={reachable} onSave={(extraOptions) => onSettings({ extraOptions })} />
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

/**
 * Options passed to llama.cpp for every model, with their own draft and Save:
 * the card's other controls apply as they are touched, but a half-typed row
 * must not restart the runtime. Usable while the runtime is in error, since a
 * value it cannot read is one way to get there.
 */
function RouterOptions({
  runtime,
  reachable,
  onSave,
}: {
  runtime: LocalRuntimeView;
  reachable: boolean;
  onSave: (rows: ExtraOption[]) => Promise<boolean>;
}) {
  const saved = runtime.extraOptions ?? [];
  const savedKey = JSON.stringify(saved);
  const [rows, setRows] = useState<OptionRow[]>(saved);
  const [saving, setSaving] = useState(false);
  // Follows what the server says until the admin starts typing, so a poll
  // never throws a half-typed row away.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setRows(JSON.parse(savedKey) as OptionRow[]);
  }, [savedKey]);
  const { options, unavailable } = useLlamaOptions(true, `${runtime.tag}:${runtime.version?.reported ?? ''}:${String(runtime.state === 'running')}`);
  const problems = rowProblems(rows, options, saved);
  const changed = !sameOptions(rows, saved);
  const clearing = rowsToSave(rows).length === 0;

  return (
    <VStack space="sm">
      <ExtraOptionsEditor
        scope="router"
        rows={rows}
        onChange={(next) => {
          touched.current = true;
          setRows(next);
        }}
        options={options}
        unavailable={unavailable}
        problems={problems}
        skipped={runtime.extraOptionsSkipped ?? []}
        disabled={!reachable || saving}
      />
      {changed && (
        <HStack>
          <Button
            testID="localModels.extraOptions.router.save"
            size="sm"
            className="bg-primary"
            isDisabled={saving || !reachable || problems.some((p) => p !== null) || (options === null && !clearing)}
            onPress={() => {
              setSaving(true);
              void onSave(rowsToSave(rows))
                .then((ok) => {
                  if (ok) touched.current = false;
                })
                .finally(() => { setSaving(false); });
            }}
          >
            <ButtonText className="text-primary-foreground">{saving ? 'Saving…' : 'Save and restart'}</ButtonText>
          </Button>
        </HStack>
      )}
    </VStack>
  );
}
