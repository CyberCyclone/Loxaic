import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { rowFiles, rowMeta, rowMmproj, type LocalModelRow } from "./catalog.ts";
import { presetLines, type LoadSettings } from "./load-settings.ts";
import { modelFilePath, presetPath } from "./paths.ts";

/**
 * The router's preset file: one section per servable model, named with the
 * model's id, which is also the reference users send. Measured against a real
 * router (b11149): a section name like `unsloth/Qwen3-8B-GGUF:Q4_K_M` is
 * accepted as the model id, and a live `GET /models?reload=1` re-reads this
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
}

/** A value that can sit on the right of `key = value` without breaking the
 * format: no line breaks, and nothing a section header could be mistaken for.
 * Paths are ours (models dir + a validated repo path), so this only ever fires
 * on a bug — and then it refuses rather than writing a broken file. */
function safeValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("Refusing a preset value containing a line break");
  return v;
}

/** Section names are model ids: `owner/repo:QUANT`. Validated when the row is
 * created; re-checked because a `]` or newline here would corrupt every
 * section after it. */
export function isSafeSectionName(id: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(id);
}

export function modelSection(row: LocalModelRow, globals: PresetGlobals): string[] {
  const files = rowFiles(row);
  if (files.length === 0 || !isSafeSectionName(row.id)) return [];
  const mmproj = rowMmproj(row);
  const lines = [`[${row.id}]`, `model = ${safeValue(modelFilePath(row.repo, files[0].path))}`];
  const settings = (row.loadSettings ?? {}) as LoadSettings;
  const cpuOnly = globals.devices === "none";
  lines.push(
    ...presetLines(cpuOnly ? { ...settings, gpuLayers: 0 } : settings, {
      mmprojPath: mmproj ? safeValue(modelFilePath(row.repo, mmproj.path)) : null,
      facts: rowMeta(row),
    }),
  );
  return lines;
}

export function renderPreset(rows: LocalModelRow[], globals: PresetGlobals): string {
  const out = [
    "; Written by Loxaic — edits are overwritten. Change model settings in",
    "; Settings > Local models instead.",
    "version = 1",
    "",
    "[*]",
    // Native OpenAI tool calling needs the model's own chat template.
    "jinja = true",
  ];
  if (globals.devices === "none") out.push("device = none", "n-gpu-layers = 0");
  else if (globals.devices && globals.devices.length > 0) out.push(`device = ${globals.devices.join(",")}`);
  for (const row of rows) {
    const section = modelSection(row, globals);
    if (section.length === 0) continue;
    out.push("", ...section);
  }
  return out.join("\n") + "\n";
}

/** Write the file atomically — the router may re-read it at any moment, and a
 * half-written file would fail the reload (or, at boot, the router). */
export async function writePreset(text: string): Promise<void> {
  const target = presetPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${String(process.pid)}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, target);
}

/** Per-model section text, for telling which models a rewrite changes. */
export function sectionsById(rows: LocalModelRow[], globals: PresetGlobals): Map<string, string> {
  return new Map(rows.map((r) => [r.id, modelSection(r, globals).join("\n")]));
}
