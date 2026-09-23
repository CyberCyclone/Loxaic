import type {
  FitLabel,
  LoadSettingSpec,
  LoadSettingValue,
  LoadSettings,
  LocalModel,
  LocalModelsView,
  LocalRuntimeView,
} from '@loxaic/api-client';

/**
 * Pure helpers for the Local models screen, kept out of the components so the
 * wording and the decisions — which warning, how often to poll, what a typed
 * value means — are unit-tested rather than only eyeballed.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${String(Math.round(bytes / 1024 ** 2))} MB`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(bytes)} B`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatParams(n: number | null | undefined): string | null {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B params`;
  return `${String(Math.round(n / 1e6))}M params`;
}

/** The label a person reads. Never colour alone — the text says it. */
export const FIT_TEXT: Record<FitLabel, string> = {
  'will-fit': 'Will fit',
  'might-fit': 'Might fit',
  'wont-fit': "Won't fit",
  unknown: 'Fit unknown',
};

/** Semantic token classes per label — never numbered colours (AGENTS.md). */
export const FIT_CLASS: Record<FitLabel, string> = {
  'will-fit': 'bg-success/15 text-success',
  'might-fit': 'bg-warning/15 text-warning',
  'wont-fit': 'bg-destructive/15 text-destructive',
  unknown: 'bg-muted text-muted-foreground',
};

/** What the runtime card leads with. */
export function runtimeHeadline(rt: LocalRuntimeView): string {
  switch (rt.state) {
    case 'off':
      return 'Local models are off';
    case 'not-installed':
      return 'Setting up llama.cpp…';
    case 'needs-gpu':
      return 'No supported GPU found';
    case 'installing':
      return 'Downloading llama.cpp…';
    case 'starting':
      return 'Starting llama.cpp…';
    case 'running':
      return rt.cpuActive ? 'Running on the CPU' : `Running on ${gpuSummary(rt)}`;
    case 'error':
      return 'llama.cpp is not running';
  }
}

export function gpuSummary(rt: LocalRuntimeView): string {
  const active = rt.activeDevices === 'none' ? [] : rt.activeDevices;
  const devices = rt.devices.filter((d) => active.includes(d.name));
  if (devices.length > 0) return devices.map((d) => d.description).join(' + ');
  const gpus = rt.hardware?.gpus ?? [];
  return gpus.length > 0 ? gpus.map((g) => g.name).join(' + ') : 'the GPU';
}

/**
 * The warning shown before switching to the CPU. Two of them, because the two
 * situations are different decisions: with a GPU present the admin is choosing
 * to leave it idle; without one, CPU is the only option there is.
 */
export function cpuWarning(rt: LocalRuntimeView): { title: string; message: string; confirm: string } {
  if (rt.gpuAvailable) {
    return {
      title: `Leave ${gpuSummary(rt)} unused?`,
      message:
        `Models will run on the CPU instead of ${gpuSummary(rt)}. Replies will be many times slower, and ` +
        'most models will be too slow to use. Only small models (a few billion parameters, such as Bonsai) are ' +
        'practical on a CPU. You can switch back at any time.',
      confirm: 'Use the CPU anyway',
    };
  }
  return {
    title: 'Run models on the CPU?',
    message:
      'No supported GPU was found, so models would run on the CPU. That is much slower than a GPU: only small ' +
      'models (a few billion parameters, such as Bonsai) are practical, and larger ones may take minutes per reply.',
    confirm: 'Use the CPU (small models only)',
  };
}

/** How often to ask the server while something is moving, and while nothing is. */
export function pollIntervalMs(view: LocalModelsView | null): number {
  if (!view) return 1000;
  const busyRuntime = ['not-installed', 'installing', 'starting'].includes(view.runtime.state);
  const busyModel = view.models.some((m) => m.status === 'queued' || m.status === 'downloading');
  return busyRuntime || busyModel ? 1000 : 15_000;
}

export function progressPercent(m: Pick<LocalModel, 'bytesDone' | 'sizeBytes'>): number {
  if (m.sizeBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((m.bytesDone / m.sizeBytes) * 100)));
}

/**
 * Seconds left for a download, from two samples of its byte count. Null until
 * there is a rate to go on, and once nothing is left.
 */
export function etaSeconds(prev: { at: number; bytes: number } | null, now: { at: number; bytes: number }, total: number): number | null {
  if (!prev || now.at <= prev.at || now.bytes <= prev.bytes) return null;
  const rate = (now.bytes - prev.bytes) / ((now.at - prev.at) / 1000);
  const left = total - now.bytes;
  if (left <= 0 || rate <= 0) return null;
  return Math.ceil(left / rate);
}

export function formatEta(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${String(seconds)} s left`;
  if (seconds < 3600) return `${String(Math.ceil(seconds / 60))} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

// ── Load settings drafts ────────────────────────────────────────────────────

/** A setting's upper bound for this model, resolving the model-fact ceilings. */
export function specMax(spec: LoadSettingSpec, meta: LocalModel['meta']): number | null {
  if (spec.max === 'nCtxTrain') return meta.nCtxTrain ?? null;
  if (spec.max === 'nLayers') return meta.nLayers != null ? meta.nLayers + 1 : null;
  return spec.max ?? null;
}

/**
 * What a typed value means for a numeric setting: blank is "llama.cpp's
 * default" (the key is removed), a number in range is the value, a word the
 * spec allows (`all`) is itself, and anything else is an error sentence.
 */
export function parseNumericInput(
  spec: LoadSettingSpec,
  raw: string,
  meta: LocalModel['meta'],
): { value: LoadSettingValue | null } | { error: string } {
  const text = raw.trim();
  if (text === '') return { value: null };
  if (spec.words?.includes(text.toLowerCase())) return { value: text.toLowerCase() };
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `${spec.label} must be a number` };
  if (spec.type === 'int' && !Number.isInteger(n)) return { error: `${spec.label} must be a whole number` };
  const max = specMax(spec, meta);
  if (spec.min !== undefined && n < spec.min) return { error: `${spec.label} must be at least ${String(spec.min)}` };
  if (max !== null && n > max) return { error: `${spec.label} can be at most ${String(max)}` };
  return { value: n };
}

/** Apply one edit to a settings draft; `null` removes the key. */
export function setDraft(draft: LoadSettings, key: string, value: LoadSettingValue | null): LoadSettings {
  const next = { ...draft };
  if (value === null) Reflect.deleteProperty(next, key);
  else next[key] = value;
  return next;
}

export const GROUP_TITLES: Record<LoadSettingSpec['group'], string> = {
  context: 'Context',
  offload: 'GPU offload',
  performance: 'Performance',
  sampling: 'Sampling defaults',
  other: 'Other',
};

export const GROUP_ORDER: LoadSettingSpec['group'][] = ['context', 'offload', 'performance', 'sampling', 'other'];
