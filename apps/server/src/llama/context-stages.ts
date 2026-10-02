import type { LocalModelMeta, LocalModelRow } from "./catalog.ts";
import { INT32_MAX, LoadSettingsError, normalizeLoadSettings, type LoadSettings } from "./load-settings.ts";

/**
 * YaRN context stages: the larger contexts a model can be reloaded at, one at a
 * time, beyond its standard one.
 *
 * **A stage is model-wide.** YaRN and `ctx-size` are fixed when llama.cpp
 * loads a model, so a stage is not something a request or a conversation can
 * have on its own: moving to one reloads the model for everyone using it, and
 * everyone's cached prompt with it. That is why the stage lives on the row
 * (`active_stage`) and why changing it waits its turn (context-stage-switch.ts).
 *
 * **Stage 0 is the model's ordinary load settings**, untouched; stages 1..n
 * each name a larger context and the YaRN values it loads with. The flags were
 * confirmed against a real b11149 router before any of this was written: a
 * preset carrying `rope-scaling`, `rope-scale`, `yarn-orig-ctx` and the four
 * `yarn-*` knobs boots and reloads, and each becomes the matching flag. An
 * unknown key would stop the router from starting at all, so nothing here is
 * written from an admin's string — every value is typed and range-checked.
 *
 * **The factor follows the context.** YaRN's scale is target ÷ original
 * (1M ÷ 256K = 4), so it is derived from the stage's context unless the admin
 * pins one. `rope-scale` and `rope-freq-scale` set the same parameter in
 * llama.cpp, so stages are refused while the base settings carry the latter.
 *
 * **YaRN is static in llama.cpp**: the scaling applies to every position of
 * every request, short prompts included, which costs a little quality on
 * short conversations. That trade is why the standard stage exists and why a
 * new conversation steps back down to it.
 */

export const MAX_STAGES = 6;
export type WhoMayChange = "everyone" | "admins";
export type WhenFull = "compact" | "extend";

export interface ContextStage {
  ctxSize: number;
  /** Pinned YaRN factor; derived from `ctxSize ÷ yarnOrigCtx` when absent. */
  ropeScale?: number;
  /** The model's original context; its trained context when absent. */
  yarnOrigCtx?: number;
  extFactor?: number;
  attnFactor?: number;
  betaSlow?: number;
  betaFast?: number;
  ropeFreqBase?: number;
  /** A long stage usually only fits with a quantized cache. */
  cacheTypeK?: string;
  cacheTypeV?: string;
}

export interface ContextStagesConfig {
  enabled: boolean;
  whoMayChange: WhoMayChange;
  whenFull: WhenFull;
  stages: ContextStage[];
}

interface Range {
  min: number;
  max: number;
  int?: boolean;
}

const STAGE_NUMBERS: Record<string, Range & { label: string }> = {
  ropeScale: { min: 1, max: 64, label: "The YaRN factor" },
  yarnOrigCtx: { min: 512, max: INT32_MAX, int: true, label: "The original context" },
  // llama.cpp's own defaults for these four are -1 ("derive it"), so -1 is in range.
  extFactor: { min: -1, max: 1, label: "The extrapolation mix" },
  attnFactor: { min: -1, max: 10, label: "The attention factor" },
  betaSlow: { min: -1, max: 1024, label: "Beta slow" },
  betaFast: { min: -1, max: 1024, label: "Beta fast" },
  ropeFreqBase: { min: 1, max: 1e10, label: "The RoPE frequency base" },
};

/** The standard stage's context: the admin's setting, else the trained one. */
export function standardContext(settings: LoadSettings, meta: LocalModelMeta): number | null {
  return typeof settings.ctxSize === "number" ? settings.ctxSize : (meta.nCtxTrain ?? null);
}

/** The YaRN factor a stage loads with, to two decimals. */
export function stageFactor(stage: ContextStage, meta: LocalModelMeta): number | null {
  if (stage.ropeScale !== undefined) return stage.ropeScale;
  const orig = stage.yarnOrigCtx ?? meta.nCtxTrain ?? null;
  if (!orig) return null;
  return Math.round((stage.ctxSize / orig) * 100) / 100;
}

/**
 * The factor a stage actually stretches by, or null when it does not need
 * YaRN at all: a stage no larger than the context the model was trained for
 * (a standard context set below it, say, and a stage above that) is simply a
 * larger `ctx-size`. Scaling by less than 1 would compress positions, which is
 * not extending anything.
 */
export function yarnFactorOf(stage: ContextStage, meta: LocalModelMeta): number | null {
  const factor = stageFactor(stage, meta);
  return factor !== null && factor > 1 ? factor : null;
}

/**
 * Validate an admin's stages against the model and its base settings. Null
 * (or `stages: []` with `enabled: false`) clears them. Unknown keys are refused,
 * never dropped, like the load settings.
 */
export function normalizeContextStages(raw: unknown, meta: LocalModelMeta, base: LoadSettings): ContextStagesConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new LoadSettingsError("Context stages must be an object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["enabled", "whoMayChange", "whenFull", "stages"].includes(key)) throw new LoadSettingsError(`"${key}" is not a context stage setting`);
  }
  const enabled = obj.enabled ?? false;
  if (typeof enabled !== "boolean") throw new LoadSettingsError("enabled must be true or false");
  const whoMayChange = obj.whoMayChange ?? "everyone";
  if (whoMayChange !== "everyone" && whoMayChange !== "admins") throw new LoadSettingsError("whoMayChange must be everyone or admins");
  const whenFull = obj.whenFull ?? "compact";
  if (whenFull !== "compact" && whenFull !== "extend") throw new LoadSettingsError("whenFull must be compact or extend");
  const rawStages = obj.stages ?? [];
  if (!Array.isArray(rawStages)) throw new LoadSettingsError("stages must be a list");
  if (rawStages.length > MAX_STAGES) throw new LoadSettingsError(`A model can have at most ${String(MAX_STAGES)} extended stages`);
  if (enabled && rawStages.length === 0) throw new LoadSettingsError("Add at least one extended stage, or turn extended context off");
  if (enabled && typeof base.ropeFreqScale === "number") {
    throw new LoadSettingsError(
      "Clear RoPE frequency scale before turning on extended context: YaRN sets the same scaling, and the two would multiply",
    );
  }

  const standard = standardContext(base, meta);
  const stages: ContextStage[] = [];
  let previous = standard ?? 0;
  rawStages.forEach((entry, i) => {
    const n = i + 1;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new LoadSettingsError(`Stage ${String(n)} must be an object`);
    const e = entry as Record<string, unknown>;
    const stage: ContextStage = { ctxSize: 0 };
    for (const [key, value] of Object.entries(e)) {
      if (value === null || value === undefined) continue;
      if (key === "ctxSize") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 512 || value > INT32_MAX) {
          throw new LoadSettingsError(`Stage ${String(n)}'s context must be a whole number from 512 to ${String(INT32_MAX)}`);
        }
        stage.ctxSize = value;
      } else if (key === "cacheTypeK" || key === "cacheTypeV") {
        // The same whitelist as the base settings' cache types.
        const checked = normalizeLoadSettings({ [key]: value }, meta);
        stage[key] = checked[key] as string;
      } else if (key in STAGE_NUMBERS) {
        const r = STAGE_NUMBERS[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < r.min || value > r.max || (r.int && !Number.isInteger(value))) {
          throw new LoadSettingsError(`Stage ${String(n)}: ${r.label} must be ${r.int ? "a whole number" : "a number"} from ${String(r.min)} to ${String(r.max)}`);
        }
        (stage as unknown as Record<string, number>)[key] = value;
      } else {
        throw new LoadSettingsError(`"${key}" is not a stage setting`);
      }
    }
    if (!stage.ctxSize) throw new LoadSettingsError(`Stage ${String(n)} needs a context length`);
    if (stage.ctxSize <= previous) {
      throw new LoadSettingsError(
        n === 1
          ? `Stage 1 must be larger than the standard context (${String(previous)})`
          : `Stage ${String(n)} must be larger than stage ${String(n - 1)}`,
      );
    }
    if (stage.ropeScale === undefined && !(stage.yarnOrigCtx ?? meta.nCtxTrain)) {
      throw new LoadSettingsError(`Stage ${String(n)} needs a YaRN factor or an original context: this file does not say how long it was trained for`);
    }
    previous = stage.ctxSize;
    stages.push(stage);
  });
  return { enabled, whoMayChange, whenFull, stages };
}

/** The row's stages as stored, or null. A stored value that no longer
 * validates (a hand-edited row, base settings changed under it) reads as
 * none: the model then loads at its standard settings rather than at a stage
 * nothing can describe. */
export function rowStages(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings">): ContextStagesConfig | null {
  try {
    const config = normalizeContextStages(row.contextStages, row.meta as LocalModelMeta, row.loadSettings as LoadSettings);
    return config?.enabled ? config : null;
  } catch {
    return null;
  }
}

/** The stage the model loads at, clamped: a stage an admin removed falls back
 * to the highest one left, and disabled stages mean standard. */
export function activeStageIndex(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings" | "activeStage">): number {
  const config = rowStages(row);
  if (!config) return 0;
  return Math.max(0, Math.min(row.activeStage, config.stages.length));
}

/** Every stage's context, standard first. Null entries where unknown. */
export function stageContexts(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings">): (number | null)[] {
  const base = (row.loadSettings ?? {}) as LoadSettings;
  const standard = standardContext(base, row.meta as LocalModelMeta);
  return [standard, ...(rowStages(row)?.stages.map((s) => s.ctxSize) ?? [])];
}

/**
 * The load settings a stage loads with: the base settings, with the stage's
 * context, cache types and frequency base on top. Every consumer of "what will
 * this model load with" — the preset, the fit estimate, eviction and the
 * listing's window — goes through this, so none of them plans for 256K while
 * the router loads 1M.
 */
export function settingsForStage(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings">, index: number): LoadSettings {
  const base = (row.loadSettings ?? {}) as LoadSettings;
  if (index <= 0) return base;
  const stage = rowStages(row)?.stages[index - 1];
  if (!stage) return base;
  const out: LoadSettings = { ...base, ctxSize: stage.ctxSize };
  if (stage.cacheTypeK) out.cacheTypeK = stage.cacheTypeK;
  if (stage.cacheTypeV) out.cacheTypeV = stage.cacheTypeV;
  if (stage.ropeFreqBase !== undefined) out.ropeFreqBase = stage.ropeFreqBase;
  return out;
}

export function effectiveSettings(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings" | "activeStage">): LoadSettings {
  return settingsForStage(row, activeStageIndex(row));
}

/** The YaRN preset lines for a stage (none for the standard stage). The
 * context, cache types and frequency base ride the ordinary settings. */
export function yarnLines(row: Pick<LocalModelRow, "contextStages" | "meta" | "loadSettings">, index: number): string[] {
  if (index <= 0) return [];
  const stage = rowStages(row)?.stages[index - 1];
  if (!stage) return [];
  const meta = row.meta as LocalModelMeta;
  const factor = yarnFactorOf(stage, meta);
  const orig = stage.yarnOrigCtx ?? meta.nCtxTrain ?? null;
  if (factor === null) return [];
  const lines = ["rope-scaling = yarn", `rope-scale = ${String(factor)}`];
  if (orig) lines.push(`yarn-orig-ctx = ${String(orig)}`);
  if (stage.extFactor !== undefined) lines.push(`yarn-ext-factor = ${String(stage.extFactor)}`);
  if (stage.attnFactor !== undefined) lines.push(`yarn-attn-factor = ${String(stage.attnFactor)}`);
  if (stage.betaSlow !== undefined) lines.push(`yarn-beta-slow = ${String(stage.betaSlow)}`);
  if (stage.betaFast !== undefined) lines.push(`yarn-beta-fast = ${String(stage.betaFast)}`);
  return lines;
}
