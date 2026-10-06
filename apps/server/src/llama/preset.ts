import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { mtpSource, rowFiles, rowMeta, rowMmproj, rowMtpHead, type LocalModelRow } from "./catalog.ts";
import { activeStageIndex, settingsForStage, yarnLines } from "./context-stages.ts";
import { coerceExtraOptions, extraOptionLines, type ExtraOption, type OptionList } from "./extra-options.ts";
import { presetLines } from "./load-settings.ts";
import { modelFilePath, presetPath } from "./paths.ts";

/**
 * The router's preset file: one section per servable model, named with the
 * model's router name (`routerModelName`, below). Measured against a real
 * router (b11149): a live `GET /models?reload=1` re-reads this
 * file — new sections appear, removed ones go, and a *changed* section that is
 * loaded is unloaded so its next request picks the new settings up. Unchanged
 * loaded models are kept.
 *
 * Everything that reaches this file is rendered here from validated values;
 * one unknown key stops the router from starting (see load-settings.ts).
 */

export interface PresetGlobals {
  /** `--device` for every model: device names, or `none` for CPU only. */
  devices: string[] | "none" | null;
  /** Have each model log where it put its memory (placement.ts). llama.cpp
   * prints its allocation lines only at verbosity 4; the cost is the model's
   * metadata dump at each load (a few hundred lines) and some forty lines a
   * request, never a prompt's text. Off where nothing reads the log (attach
   * mode: the sidecar's output stays in Docker's). */
  placementLog?: boolean;
  /** The options the build reading this file lists in its `--help`, or null
   * when it could not be asked. Extra options are written only when known to
   * it (extra-options.ts). */
  options?: OptionList | null;
  /** The admin's options for every model, written to `[*]`. */
  extraOptions?: readonly ExtraOption[];
}

/** A value that can sit on the right of `key = value` without breaking the
 * format: no line breaks, and nothing a section header could be mistaken for.
 * Paths are ours (models dir + a validated repo path), so this only ever fires
 * on a bug — and then it refuses rather than writing a broken file. */
function safeValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("Refusing a preset value containing a line break");
  return v;
}

/** Model ids are `owner/repo:QUANT`. Validated when the row is created;
 * re-checked here because a `]` or newline in a section name would corrupt
 * every section after it. */
export function isSafeSectionName(id: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(id);
}

/**
 * The name the router knows a model by: its id with the ":" as "@".
 *
 * Not the id itself, because b11149 reads a section name with a ":" as a
 * HuggingFace `repo:quant` reference and rewrites the quant — uppercased, a
 * leading "UD-" dropped — then serves the model under the *rewritten* name.
 * `[unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_XL]` was listed as
 * `…:Q5_K_XL`, so every request for the id it was downloaded as was
 * "not found", and its status lookups missed it too. A name without a ":" is
 * served exactly as written. "@" cannot occur in an id (isSafeSectionName), so
 * the mapping is one-to-one and two quants can never collide — which the
 * router's own rewrite does allow (`q4_k_m` and `Q4_K_M` became one model).
 *
 * The id stays the reference everywhere else — messages, prefs, usage, the
 * listing — so nothing stored changes. Every call that names a model to the
 * router goes through this, and `modelIdFromRouterName` reads its answers back.
 */
export function routerModelName(id: string): string {
  return id.replace(":", "@");
}

/** The model id for a name the router reports; names it did not get from
 * `routerModelName` are returned as they are. */
export function modelIdFromRouterName(name: string): string {
  return name.includes(":") ? name : name.replace("@", ":");
}

export function modelSection(row: LocalModelRow, globals: PresetGlobals): string[] {
  const files = rowFiles(row);
  if (files.length === 0 || !isSafeSectionName(row.id)) return [];
  const mmproj = rowMmproj(row);
  const lines = [
    `[${routerModelName(row.id)}]`,
    `model = ${safeValue(modelFilePath(row.repo, row.revision, files[0].path))}`,
  ];
  // The active YaRN stage's context (and cache types) on top of the model's
  // own settings; stage 0 is the settings as they are.
  const stage = activeStageIndex(row);
  const settings = settingsForStage(row, stage);
  const cpuOnly = globals.devices === "none";
  lines.push(
    ...presetLines(cpuOnly ? { ...settings, gpuLayers: 0 } : settings, {
      mmprojPath: mmproj ? safeValue(modelFilePath(row.repo, row.revision, mmproj.path)) : null,
      facts: rowMeta(row),
      mtp: mtpDraft(row),
    }),
    ...yarnLines(row, stage),
    // The admin's own options last, after everything Loxaic writes. A key here
    // beats the same key in `[*]` (llama.cpp's own precedence).
    ...extraOptionLines(coerceExtraOptions(row.extraOptions), globals.options ?? null).lines,
  );
  return lines;
}

/** What MTP drafts with, for `presetLines`: the model's own head (no draft
 * file), a separate head that has finished downloading and passed its header
 * check (its path, under its own revision), or nothing yet. */
function mtpDraft(row: LocalModelRow): { draftModelPath: string | null } | null {
  const source = mtpSource(row);
  if (source === "embedded") return { draftModelPath: null };
  const head = rowMtpHead(row);
  if (source === "head" && head) return { draftModelPath: safeValue(modelFilePath(row.repo, head.revision, head.path)) };
  return null;
}

export function renderPreset(rows: LocalModelRow[], globals: PresetGlobals): string {
  const out = [
    "; Written by Loxaic — edits are overwritten. Change model settings in",
    "; Settings > Host models instead.",
    "version = 1",
    "",
    "[*]",
    // Native OpenAI tool calling needs the model's own chat template.
    "jinja = true",
  ];
  if (globals.placementLog) out.push("log-verbosity = 4");
  if (globals.devices === "none") out.push("device = none", "n-gpu-layers = 0");
  else if (globals.devices && globals.devices.length > 0) out.push(`device = ${globals.devices.join(",")}`);
  out.push(...extraOptionLines(globals.extraOptions, globals.options ?? null).lines);
  for (const row of rows) {
    const section = modelSection(row, globals);
    if (section.length === 0) continue;
    out.push("", ...section);
  }
  return out.join("\n") + "\n";
}

/** Write the file atomically — the router may re-read it at any moment, and a
 * half-written file would fail the reload (or, at boot, the router). The temp
 * name is per *call*, not per process: two overlapping writes with one name
 * would splice into each other, and the rename would publish the splice. */
export async function writePreset(text: string): Promise<void> {
  const target = presetPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${String(process.pid)}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, target);
}

/** Per-model section text, for telling which models a rewrite changes. */
export function sectionsById(rows: LocalModelRow[], globals: PresetGlobals): Map<string, string> {
  return new Map(rows.map((r) => [r.id, modelSection(r, globals).join("\n")]));
}
