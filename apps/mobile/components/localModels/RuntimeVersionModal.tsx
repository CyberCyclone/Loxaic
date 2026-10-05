import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react-native';
import {
  getRuntimeVersions,
  type CustomRuntimeBackend,
  type CustomRuntimeBuild,
  type LocalRuntimeView,
  type RuntimeReleaseRow,
  type RuntimeSelection,
  type RuntimeVersionsView,
} from '@loxaic/api-client';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Input, InputField } from '@/components/ui/input';
import { PresetChips } from '@/components/settings/PresetChips';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { formatBytes } from '@/lib/localModels';
import {
  canDeleteRelease,
  customAction,
  customBuildProblem,
  downloadForCustom,
  downloadForTag,
  releaseAction,
  releaseRows,
  shortHash,
  staleNote,
  switchWarning,
  VERSION_CAVEAT,
  type RowAction,
} from '@/lib/runtimeVersions';
import { TRUNCATE_TEXT } from '@/lib/truncate';

export interface RuntimeVersionActions {
  downloadVersion: (tag: string) => Promise<boolean>;
  deleteVersion: (tag: string) => Promise<boolean>;
  addCustom: (build: {
    name: string;
    url: string;
    sha256?: string | null;
    backend: CustomRuntimeBackend;
    cpuAcknowledged?: boolean;
  }) => Promise<boolean>;
  retryCustom: (id: string) => Promise<boolean>;
  deleteCustom: (id: string) => Promise<boolean>;
  selectVersion: (selection: RuntimeSelection) => Promise<boolean>;
}

interface RuntimeVersionModalProps {
  open: boolean;
  /** The polled runtime: what is chosen now, and the downloads under way. */
  runtime: LocalRuntimeView;
  onClose: () => void;
  actions: RuntimeVersionActions;
}

const CUSTOM_BACKENDS: { value: CustomRuntimeBackend; label: string }[] = [
  { value: 'metal', label: 'Metal' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'rocm', label: 'ROCm' },
  { value: 'cpu', label: 'CPU' },
];

type SwitchTarget =
  | { kind: 'bundled' }
  | { kind: 'official'; tag: string }
  | { kind: 'custom'; id: string; name: string };

function Pill({ label, tone, testID }: { label: string; tone: 'warning' | 'primary' | 'success' | 'muted'; testID?: string }) {
  const cls =
    tone === 'warning'
      ? 'bg-warning/15 text-warning'
      : tone === 'primary'
        ? 'bg-primary/15 text-primary'
        : tone === 'success'
          ? 'bg-success/15 text-success'
          : 'bg-muted text-muted-foreground';
  const [bg, fg] = cls.split(' ');
  return (
    <Box className={`rounded-full px-2 py-0.5 ${bg}`}>
      <Text testID={testID} size="2xs" className={fg}>
        {label}
      </Text>
    </Box>
  );
}

/**
 * Which llama.cpp this host runs (#270): the bundled version, any official
 * release, or a third-party build added by its download address.
 *
 * Downloading and switching are separate steps on purpose. A download touches
 * nothing that is running; a switch restarts the runtime and unloads every
 * model, so it is only ever offered for a version already on this machine and
 * always asks first — inline, since nothing in this app stacks dialogs.
 */
export function RuntimeVersionModal({ open, runtime, onClose, actions }: RuntimeVersionModalProps) {
  const reachable = useServerReachable();
  const [view, setView] = useState<RuntimeVersionsView | null>(null);
  /** The pages of releases loaded so far, by page number. */
  const [pages, setPages] = useState<Record<number, RuntimeReleaseRow[]>>({});
  const [found, setFound] = useState<RuntimeReleaseRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<SwitchTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; url: string; sha256: string; backend: CustomRuntimeBackend }>({
    name: '',
    url: '',
    sha256: '',
    backend: 'vulkan',
  });
  const [formTouched, setFormTouched] = useState(false);
  // A slow answer for an earlier page or search must not land over a later one.
  const request = useRef(0);

  const load = useCallback(async (opts: { page: number; q: string }) => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const next = await getRuntimeVersions(opts.q ? { q: opts.q } : { page: opts.page });
      if (mine !== request.current) return;
      setView(next);
      setError(null);
      if (opts.q) {
        setFound(next.official.releases);
      } else {
        setFound(null);
        setPages((p) => (opts.page === 1 ? { 1: next.official.releases } : { ...p, [opts.page]: next.official.releases }));
        setHasMore(next.official.hasMore);
      }
    } catch (err) {
      if (mine !== request.current) return;
      // "Could not ask" is not "there are none": the list stays as it was.
      setError(describeRequestError(err, 'Could not load the versions'));
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, []);

  // What is chosen, and which downloads are running or have failed. When any
  // of it changes — a download finishing drops out of the list — the first
  // page is asked for again, which is also where "downloaded" comes from.
  const signature = useMemo(
    () =>
      JSON.stringify([
        runtime.version?.kind,
        runtime.version?.tag,
        runtime.version?.name,
        (runtime.versionDownloads ?? []).map((d) => [d.key, d.active, d.error !== null]),
      ]),
    [runtime.version, runtime.versionDownloads],
  );

  useEffect(() => {
    if (!open) {
      request.current++;
      setTarget(null);
      return;
    }
    void load({ page: 1, q: searched });
    // `searched` is read as it is now; a new search loads for itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature, load]);

  // The server coming back is a reason to ask again when the last ask failed.
  useEffect(() => {
    if (open && reachable && error) void load({ page: 1, q: searched });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable]);

  const runSearch = (q: string) => {
    const trimmed = q.trim();
    setSearched(trimmed);
    void load({ page: 1, q: trimmed });
  };

  const downloads = runtime.versionDownloads;
  const loaded = useMemo(
    () =>
      Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((n) => pages[n] ?? []),
    [pages],
  );
  const rows = view ? releaseRows(view, found ?? loaded, found !== null) : [];
  const stale = view ? staleNote(view.official.stale) : null;
  const restarting = Boolean(runtime.restart);
  const locked = !reachable || busy !== null || restarting;

  const run = async (key: string, fn: () => Promise<boolean>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const confirmSwitch = async () => {
    if (!target) return;
    const selection: RuntimeSelection =
      target.kind === 'custom' ? { kind: 'custom', id: target.id } : target.kind === 'official' ? { kind: 'official', tag: target.tag } : { kind: 'bundled' };
    setBusy('switch');
    try {
      const ok = await actions.selectVersion(selection);
      if (ok) {
        setTarget(null);
        // The card behind this is where the restart is shown.
        onClose();
      }
    } finally {
      setBusy(null);
    }
  };

  const warning = target ? switchWarning(target) : null;
  const problem = customBuildProblem(form);

  const addCustom = async () => {
    setFormTouched(true);
    if (problem) return;
    const sha = form.sha256.trim();
    setBusy('add');
    try {
      const ok = await actions.addCustom({
        name: form.name.trim(),
        url: form.url.trim(),
        sha256: sha || null,
        backend: form.backend,
        ...(form.backend === 'cpu' ? { cpuAcknowledged: true } : {}),
      });
      if (ok) {
        setForm((f) => ({ ...f, name: '', url: '', sha256: '' }));
        setFormTouched(false);
      }
    } finally {
      setBusy(null);
    }
  };

  const actionButton = (action: RowAction, ids: { base: string; onDownload: () => void; onSwitch: () => void }) => {
    if (action.kind === 'in-use') return <Pill label="In use" tone="primary" testID={`${ids.base}.inUse`} />;
    if (action.kind === 'unavailable') {
      return (
        <Text testID={`${ids.base}.unavailable`} size="xs" className="text-muted-foreground">
          {action.reason}
        </Text>
      );
    }
    if (action.kind === 'downloading') {
      return (
        <HStack space="xs" className="items-center">
          <Spinner size="small" />
          <Text testID={`${ids.base}.progress`} size="xs" className="text-muted-foreground">
            {action.percent === null ? 'Downloading…' : `Downloading ${String(action.percent)}%`}
          </Text>
        </HStack>
      );
    }
    if (action.kind === 'switch') {
      return (
        <Pressable testID={`${ids.base}.switch`} disabled={locked} onPress={ids.onSwitch} className="rounded-md bg-primary px-3 py-1.5">
          <Text size="xs" className="text-primary-foreground">
            Switch
          </Text>
        </Pressable>
      );
    }
    return (
      <Pressable testID={`${ids.base}.download`} disabled={locked} onPress={ids.onDownload} className="rounded-md bg-muted px-3 py-1.5">
        <Text size="xs" className="text-foreground">
          {action.retry ? 'Try again' : 'Download'}
        </Text>
      </Pressable>
    );
  };

  const releaseRow = (r: RuntimeReleaseRow) => {
    const base = `localModels.versions.row.${r.tag}`;
    const failed = downloadForTag(downloads, r.tag)?.error ?? null;
    return (
      <VStack key={r.tag} testID={base} className="rounded-md border border-border px-3 py-2">
        <HStack className="items-center justify-between">
          <VStack className="min-w-0 shrink pr-2">
            <HStack space="xs" className="flex-wrap items-center">
              <Text size="sm" className="text-foreground">
                {r.tag}
              </Text>
              {r.prerelease && <Pill label="Pre-release" tone="warning" testID={`${base}.prerelease`} />}
              {r.downloaded && !r.inUse && <Pill label="Downloaded" tone="success" testID={`${base}.downloaded`} />}
            </HStack>
            <Text size="2xs" className="text-muted-foreground">
              {[r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : null, r.sizeBytes ? formatBytes(r.sizeBytes) : null]
                .filter(Boolean)
                .join(' · ') || 'On this machine'}
            </Text>
          </VStack>
          <HStack space="sm" className="shrink-0 items-center">
            {actionButton(releaseAction(r, downloads), {
              base,
              onDownload: () => { void run(r.tag, () => actions.downloadVersion(r.tag)); },
              onSwitch: () => { setTarget({ kind: 'official', tag: r.tag }); },
            })}
            {canDeleteRelease(r) && (
              <Pressable
                testID={`${base}.delete`}
                disabled={locked}
                onPress={() => { void run(r.tag, () => actions.deleteVersion(r.tag)); }}
                accessibilityLabel={`Remove llama.cpp ${r.tag} from this machine`}
                className="p-1.5"
              >
                <Icon as={Trash2} size="xs" className="text-muted-foreground" />
              </Pressable>
            )}
          </HStack>
        </HStack>
        {failed && (
          <Text testID={`${base}.error`} size="xs" className="mt-1 text-destructive">
            {failed}
          </Text>
        )}
      </VStack>
    );
  };

  const customRow = (b: CustomRuntimeBuild) => {
    const base = `localModels.versions.custom.row.${b.id}`;
    const failed = downloadForCustom(downloads, b.id)?.error ?? null;
    const hash = shortHash(b.sha256);
    return (
      <VStack key={b.id} testID={base} className="rounded-md border border-border px-3 py-2">
        <HStack className="items-center justify-between">
          <VStack className="min-w-0 shrink pr-2">
            <HStack space="xs" className="flex-wrap items-center">
              <Text testID={`${base}.name`} size="sm" className="min-w-0 shrink text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {b.name}
              </Text>
              {b.downloaded && !b.inUse && <Pill label="Downloaded" tone="success" testID={`${base}.downloaded`} />}
            </HStack>
            <Text testID={`${base}.source`} size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              {[`from ${b.host}`, CUSTOM_BACKENDS.find((c) => c.value === b.backend)?.label].filter(Boolean).join(' · ')}
            </Text>
            <Text testID={`${base}.hash`} size="2xs" className="text-muted-foreground">
              {hash
                ? `SHA-256 ${hash}${b.sha256Expected ? ' · matches the one given' : ' · not checked against one'}`
                : 'Not downloaded yet'}
            </Text>
          </VStack>
          <HStack space="sm" className="shrink-0 items-center">
            {actionButton(customAction(b, downloads), {
              base,
              onDownload: () => { void run(b.id, () => actions.retryCustom(b.id)); },
              onSwitch: () => { setTarget({ kind: 'custom', id: b.id, name: b.name }); },
            })}
            {!b.inUse && (
              <Pressable
                testID={`${base}.delete`}
                disabled={locked}
                onPress={() => { void run(b.id, () => actions.deleteCustom(b.id)); }}
                accessibilityLabel={`Remove ${b.name}`}
                className="p-1.5"
              >
                <Icon as={Trash2} size="xs" className="text-muted-foreground" />
              </Pressable>
            )}
          </HStack>
        </HStack>
        {failed && (
          <Text testID={`${base}.error`} size="xs" className="mt-1 text-destructive">
            {failed}
          </Text>
        )}
      </VStack>
    );
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="lg">
      <ModalBackdrop />
      {/* Both halves, as on every modal whose content can pass the fold: the
          height cap, and scrollEnabled on the body (the vendored ModalBody
          turns it off before its prop spread). */}
      <ModalContent testID="localModels.versions" className="max-h-[85%] w-[96%] max-w-[720px] p-4 web:max-h-[94%] web:p-5">
        <ModalHeader>
          <VStack className="min-w-0 flex-1 shrink pr-2">
            <Heading size="sm">llama.cpp version</Heading>
            <Text size="xs" className="text-muted-foreground">
              Which build of llama.cpp this host runs its models with.
            </Text>
          </VStack>
          <ModalCloseButton testID="localModels.versions.close">
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled keyboardShouldPersistTaps="handled" className="mb-0 mt-3">
          <VStack space="md">
            <HStack testID="localModels.versions.caveat" space="xs" className="items-start rounded-md bg-warning/15 p-2">
              <Icon as={TriangleAlert} size="xs" className="mt-0.5 text-warning" />
              <Text size="xs" className="min-w-0 flex-1 text-foreground">
                {VERSION_CAVEAT}
              </Text>
            </HStack>

            <DisconnectedNote testID="localModels.versions.disconnected" what="change the version" />

            {warning && (
              <VStack testID="localModels.versions.confirm" space="xs" className="rounded-md bg-destructive/10 p-3">
                <Text testID="localModels.versions.confirm.title" size="sm" className="font-medium text-foreground">
                  {warning.title}
                </Text>
                <Text size="xs" className="text-foreground">
                  {warning.message}
                </Text>
                <HStack space="sm" className="justify-end">
                  <Pressable testID="localModels.versions.confirm.cancel" onPress={() => { setTarget(null); }} className="px-3 py-1.5">
                    <Text size="sm" className="text-muted-foreground">
                      Cancel
                    </Text>
                  </Pressable>
                  <Pressable
                    testID="localModels.versions.confirm.ok"
                    disabled={!reachable || busy !== null}
                    onPress={() => { void confirmSwitch(); }}
                    className="rounded-md bg-destructive px-3 py-1.5"
                  >
                    {busy === 'switch' ? (
                      <Spinner size="small" />
                    ) : (
                      <Text size="sm" className="text-destructive-foreground">
                        {warning.confirm}
                      </Text>
                    )}
                  </Pressable>
                </HStack>
              </VStack>
            )}

            {!view && !error && (
              <Box className="items-center py-8">
                <Spinner />
              </Box>
            )}
            {error && (
              <Text testID="localModels.versions.error" size="sm" className="text-destructive">
                {error}
              </Text>
            )}

            {view && (
              <>
                <HStack testID="localModels.versions.bundled" className="items-center justify-between rounded-md border border-border px-3 py-2">
                  <VStack className="min-w-0 shrink pr-2">
                    <HStack space="xs" className="flex-wrap items-center">
                      <Text size="sm" className="text-foreground">
                        Bundled · {view.bundled.tag}
                      </Text>
                      <Pill label="Recommended" tone="muted" />
                    </HStack>
                    <Text size="2xs" className="text-muted-foreground">
                      The version this Loxaic was tested with. It follows Loxaic&apos;s updates.
                    </Text>
                  </VStack>
                  {view.bundled.inUse ? (
                    <Pill label="In use" tone="primary" testID="localModels.versions.bundled.inUse" />
                  ) : (
                    <Pressable
                      testID="localModels.versions.bundled.switch"
                      disabled={locked}
                      onPress={() => { setTarget({ kind: 'bundled' }); }}
                      className="shrink-0 rounded-md bg-primary px-3 py-1.5"
                    >
                      <Text size="xs" className="text-primary-foreground">
                        Switch back
                      </Text>
                    </Pressable>
                  )}
                </HStack>

                <VStack space="xs">
                  <Text size="sm" className="font-medium text-foreground">
                    Official versions
                  </Text>
                  <HStack space="sm" className="items-center">
                    <Input className="min-w-0 flex-1">
                      <InputField
                        testID="localModels.versions.search"
                        value={query}
                        onChangeText={setQuery}
                        onSubmitEditing={() => { runSearch(query); }}
                        placeholder="Find a version by its tag, such as b11342"
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                      />
                    </Input>
                    <Pressable
                      testID="localModels.versions.search.go"
                      disabled={!reachable || loading}
                      onPress={() => { runSearch(query); }}
                      className="rounded-md bg-muted px-3 py-2"
                    >
                      <Text size="sm" className="text-foreground">
                        Find
                      </Text>
                    </Pressable>
                    {searched !== '' && (
                      <Pressable
                        testID="localModels.versions.search.clear"
                        onPress={() => {
                          setQuery('');
                          runSearch('');
                        }}
                        className="p-2"
                      >
                        <Text size="sm" className="text-primary">
                          All
                        </Text>
                      </Pressable>
                    )}
                  </HStack>
                  {view.official.unavailable && (
                    <Text testID="localModels.versions.unavailable" size="xs" className="text-muted-foreground">
                      {view.official.unavailable}
                    </Text>
                  )}
                  {stale && (
                    <Text testID="localModels.versions.stale" size="xs" className="text-muted-foreground">
                      {stale}
                    </Text>
                  )}
                  {rows.map(releaseRow)}
                  {rows.length === 0 && !view.official.unavailable && !loading && (
                    <Text testID="localModels.versions.none" size="sm" className="text-muted-foreground">
                      {searched ? `llama.cpp has no release ${searched}.` : 'No releases were listed.'}
                    </Text>
                  )}
                  {found === null && hasMore && (
                    <Pressable
                      testID="localModels.versions.loadMore"
                      disabled={!reachable || loading}
                      onPress={() => { void load({ page: Math.max(0, ...Object.keys(pages).map(Number)) + 1, q: '' }); }}
                      className="self-center px-3 py-2"
                    >
                      {loading ? (
                        <Spinner size="small" />
                      ) : (
                        <Text size="sm" className="text-primary">
                          Load older versions
                        </Text>
                      )}
                    </Pressable>
                  )}
                </VStack>

                <VStack testID="localModels.versions.custom" space="xs" className="border-t border-border pt-3">
                  <Text size="sm" className="font-medium text-foreground">
                    Third-party builds
                  </Text>
                  {!view.customAllowed ? (
                    <Text testID="localModels.versions.custom.off" size="xs" className="text-muted-foreground">
                      Third-party builds are switched off on this server (LLAMA_CUSTOM_RUNTIMES=off).
                    </Text>
                  ) : (
                    <>
                      <Text size="xs" className="text-muted-foreground">
                        A fork or your own build of llama.cpp, from a direct link to its archive (.tar.gz, or .zip on
                        macOS and Windows) containing llama-server. This server will run whatever the link serves, as
                        itself: add only builds from a source you trust.
                      </Text>
                      {view.custom.map(customRow)}
                      {view.custom.length === 0 && (
                        <Text testID="localModels.versions.custom.none" size="xs" className="text-muted-foreground">
                          None added.
                        </Text>
                      )}
                      <VStack space="xs" className="mt-1 rounded-md bg-muted/40 p-3">
                        <Input>
                          <InputField
                            testID="localModels.versions.custom.name"
                            value={form.name}
                            onChangeText={(name) => { setForm((f) => ({ ...f, name })); }}
                            placeholder="Name, such as ik_llama.cpp 2026-09"
                            maxLength={60}
                          />
                        </Input>
                        <Input>
                          <InputField
                            testID="localModels.versions.custom.url"
                            value={form.url}
                            onChangeText={(url) => { setForm((f) => ({ ...f, url })); }}
                            placeholder="https://… link to the archive"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                          />
                        </Input>
                        <Input>
                          <InputField
                            testID="localModels.versions.custom.sha256"
                            value={form.sha256}
                            onChangeText={(sha256) => { setForm((f) => ({ ...f, sha256 })); }}
                            placeholder="SHA-256 of the archive (optional)"
                            autoCapitalize="none"
                            autoCorrect={false}
                          />
                        </Input>
                        <Text size="2xs" className="text-muted-foreground">
                          With a SHA-256, a download that does not match is discarded. Without one, whatever arrives is
                          used and its hash is shown here afterwards.
                        </Text>
                        <Text size="xs" className="text-muted-foreground">
                          Built for
                        </Text>
                        <PresetChips
                          chips={CUSTOM_BACKENDS.map((b) => ({ value: b.value, label: b.label, key: b.value }))}
                          value={form.backend}
                          onChoose={(backend) => { setForm((f) => ({ ...f, backend })); }}
                          disabled={!reachable}
                          testIDPrefix="localModels.versions.custom.backend"
                        />
                        {form.backend === 'cpu' && (
                          <Text testID="localModels.versions.custom.cpuWarning" size="xs" className="text-warning">
                            A CPU build runs every model on the CPU, which is much slower than a GPU: only small models
                            reply at a usable speed.
                          </Text>
                        )}
                        {formTouched && problem && (
                          <Text testID="localModels.versions.custom.problem" size="xs" className="text-destructive">
                            {problem}
                          </Text>
                        )}
                        <Pressable
                          testID="localModels.versions.custom.add"
                          disabled={!reachable || busy !== null}
                          onPress={() => { void addCustom(); }}
                          className="self-start rounded-md bg-primary px-3 py-1.5"
                        >
                          {busy === 'add' ? (
                            <Spinner size="small" />
                          ) : (
                            <Text size="sm" className="text-primary-foreground">
                              {form.backend === 'cpu' ? 'Add and download (CPU)' : 'Add and download'}
                            </Text>
                          )}
                        </Pressable>
                      </VStack>
                    </>
                  )}
                </VStack>
              </>
            )}
          </VStack>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
