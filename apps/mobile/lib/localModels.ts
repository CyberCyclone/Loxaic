import type {
  ContextStage,
  ContextStagesConfig,
  FitEstimate,
  FitLabel,
  LoadSettingSpec,
  LoadSettingValue,
  LoadSettings,
  LocalModel,
  LocalModelsView,
  LocalRuntimeView,
} from '@loxaic/api-client';

/**
 * Pure helpers for the Host models screen, kept out of the components so the
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
/** Below this, a share of memory is not worth a clause. */
const MENTION_BYTES = 512 * 1024 ** 2;

/**
 * What a fit estimate was measured against, in a sentence or two. The GPU rows
 * show each card's size, so without the breakdown "34 GB available" on two
 * 30 GB cards reads as a miscount rather than as another program holding most
 * of one card.
 */
export function describeFit(fit: FitEstimate): string {
  const needs = `Needs about ${formatBytes(fit.requiredBytes)}`;
  if (!fit.availableBytes) return needs;
  if (fit.target === 'cpu') return `${needs} of ${formatBytes(fit.availableBytes)} RAM.`;
  const b = fit.breakdown;
  if (!b) return `${needs} of ${formatBytes(fit.availableBytes)} GPU memory.`;
  const gpus = b.deviceCount === 1 ? 'the GPU' : `${String(b.deviceCount)} GPUs`;
  const parts = [`${needs} of ${formatBytes(fit.availableBytes)} available on ${gpus} (${formatBytes(b.totalBytes)} in all).`];
  if (b.reclaimableBytes >= MENTION_BYTES) {
    parts.push(`That counts ${formatBytes(b.reclaimableBytes)} other models are using, which they give up when this one loads.`);
  }
  if (b.pinnedBytes >= MENTION_BYTES) parts.push(`Pinned models keep ${formatBytes(b.pinnedBytes)}.`);
  if (b.otherBytes >= MENTION_BYTES) parts.push(`Other programs are using ${formatBytes(b.otherBytes)}.`);
  return parts.join(' ');
}

export function runtimeHeadline(rt: LocalRuntimeView): string {
  switch (rt.state) {
    case 'off':
      return 'Host models are off';
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
  const busyModel = view.models.some(
    (m) => m.status === 'queued' || m.status === 'downloading' || m.mtpHead?.status === 'queued' || m.mtpHead?.status === 'downloading',
  );
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

/** llama.cpp's own 32-bit ceiling on a count, which the server enforces even
 * where a model's trained maximum is only advice. */
const INT32_MAX = 2 ** 31 - 1;

/**
 * What a typed value means for a numeric setting: blank is "llama.cpp's
 * default" (the key is removed), a number in range is the value, a word the
 * spec allows (`all`) is itself, and anything else is an error sentence.
 *
 * A setting whose `max` is only advice (the context length's trained maximum —
 * RoPE scaling exists to exceed it) takes a value past it with a `warning`
 * instead: still a value, so Save stays possible.
 */
export function parseNumericInput(
  spec: LoadSettingSpec,
  raw: string,
  meta: LocalModel['meta'],
): { value: LoadSettingValue | null; warning?: string } | { error: string } {
  const text = raw.trim();
  if (text === '') return { value: null };
  if (spec.words?.includes(text.toLowerCase())) return { value: text.toLowerCase() };
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `${spec.label} must be a number` };
  if (spec.type === 'int' && !Number.isInteger(n)) return { error: `${spec.label} must be a whole number` };
  const max = specMax(spec, meta);
  if (spec.min !== undefined && n < spec.min) return { error: `${spec.label} must be at least ${String(spec.min)}` };
  if (spec.softMax) {
    if (n > INT32_MAX) return { error: `${spec.label} can be at most ${String(INT32_MAX)}` };
    if (max !== null && n > max) {
      return {
        value: n,
        warning: `${spec.label} is above the ${max.toLocaleString()} this model was trained for. It only works well with YaRN (Extended context, below) and uses much more memory.`,
      };
    }
    return { value: n };
  }
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
  speculative: 'Multi-token prediction',
  sampling: 'Sampling defaults',
  other: 'Other',
};

export const GROUP_ORDER: LoadSettingSpec['group'][] = ['context', 'offload', 'performance', 'speculative', 'sampling', 'other'];

// ── Extended context (YaRN stages) ──────────────────────────────────────────

/** What the admin edits: each stage's context as typed text, beside the
 * stage it came from so a field the sheet has no control for (a pinned factor,
 * an expert YaRN knob) survives an edit. */
export interface StageDraft {
  ctx: string;
  base?: ContextStage;
  cacheTypeK?: string;
  cacheTypeV?: string;
}

export interface StagesDraft {
  enabled: boolean;
  whoMayChange: 'everyone' | 'admins';
  whenFull: 'compact' | 'extend';
  stages: StageDraft[];
}

export const EMPTY_STAGES: StagesDraft = { enabled: false, whoMayChange: 'everyone', whenFull: 'compact', stages: [] };

export function draftFromConfig(config: ContextStagesConfig | null | undefined): StagesDraft {
  if (!config) return EMPTY_STAGES;
  return {
    enabled: config.enabled,
    whoMayChange: config.whoMayChange,
    whenFull: config.whenFull,
    stages: config.stages.map((s) => ({ ctx: String(s.ctxSize), base: s, cacheTypeK: s.cacheTypeK, cacheTypeV: s.cacheTypeV })),
  };
}

/** The standard stage's context: the admin's setting, else the trained one. */
export function standardCtx(draft: LoadSettings, meta: LocalModel['meta']): number | null {
  return typeof draft.ctxSize === 'number' ? draft.ctxSize : (meta.nCtxTrain ?? null);
}

/** The factor a stage would load with: target ÷ the model's original context. */
export function draftFactor(stage: StageDraft, meta: LocalModel['meta']): number | null {
  const ctx = Number(stage.ctx);
  const orig = stage.base?.yarnOrigCtx ?? meta.nCtxTrain ?? null;
  if (stage.base?.ropeScale !== undefined) return stage.base.ropeScale;
  if (!orig || !Number.isFinite(ctx) || ctx <= 0) return null;
  return Math.round((ctx / orig) * 100) / 100;
}

/** One sentence per stage that cannot be saved, or null. Mirrors the server's
 * rules so the sheet can say so before Save; the server still decides. */
export function stageErrors(draft: StagesDraft, standard: number | null, meta: LocalModel['meta']): (string | null)[] {
  let previous = standard ?? 0;
  return draft.stages.map((stage, i) => {
    const n = Number(stage.ctx);
    if (stage.ctx.trim() === '' || !Number.isInteger(n) || n < 512) return 'Enter a whole number of tokens, at least 512.';
    if (n > 2 ** 31 - 1) return `At most ${String(2 ** 31 - 1)}.`;
    if (n <= previous) {
      return i === 0 ? `Must be larger than the standard context (${previous.toLocaleString()}).` : `Must be larger than stage ${String(i)}.`;
    }
    if (draftFactor(stage, meta) === null) return 'This file does not say how long it was trained for, so the YaRN factor cannot be worked out.';
    previous = n;
    return null;
  });
}

/** The config to save: null when extended context is off and nothing was set
 * up, so a model that never used it keeps a null column. */
export function configFromDraft(draft: StagesDraft): ContextStagesConfig | null {
  if (!draft.enabled && draft.stages.length === 0) return null;
  return {
    enabled: draft.enabled,
    whoMayChange: draft.whoMayChange,
    whenFull: draft.whenFull,
    stages: draft.stages.map((s) => ({
      ...(s.base ?? {}),
      ctxSize: Number(s.ctx),
      ...(s.cacheTypeK ? { cacheTypeK: s.cacheTypeK } : { cacheTypeK: undefined }),
      ...(s.cacheTypeV ? { cacheTypeV: s.cacheTypeV } : { cacheTypeV: undefined }),
    })),
  };
}

/** How far the file itself says it can be stretched (its `rope.scaling.factor`),
 * else 4× — what YaRN's authors report holds up for the models this is for. */
function maxFactor(meta: LocalModel['meta']): number {
  const f = meta.shape?.ropeScaling?.factor;
  return typeof f === 'number' && f > 1 ? f : 4;
}

/**
 * Suggested stages: the trained context ×2, ×3, ×4 (fewer when the file says it
 * stretches less), each rounded to a multiple of 1,024. Empty when the trained
 * context is unknown.
 */
export function suggestStages(meta: LocalModel['meta'], standard: number | null): number[] {
  const trained = meta.nCtxTrain ?? null;
  if (!trained) return [];
  const out: number[] = [];
  const top = Math.floor(maxFactor(meta));
  for (let f = 2; f <= top; f++) {
    const ctx = Math.round((trained * f) / 1024) * 1024;
    if (ctx > (standard ?? 0)) out.push(ctx);
  }
  return out;
}
