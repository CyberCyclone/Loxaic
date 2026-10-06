import { LOAD_SETTINGS, LoadSettingsError } from "./load-settings.ts";

/**
 * Options an admin passes to llama.cpp as typed: `key = value` rows, per model
 * (that model's preset section) and for every model (the preset's `[*]`).
 *
 * The preset is still the only place admin input becomes process arguments,
 * and one key llama.cpp does not know stops the router from starting at all
 * (load-settings.ts). So a key is accepted only when the build that is going to
 * read it lists it in its own `--help`, which works for any release or fork,
 * and checked again each time the preset is written: a version switched to
 * later that does not know a stored key gets the file without that row,
 * rather than a router that will not start.
 *
 * Measured against b11342: a preset key is an option's name without its dashes,
 * long or short (`n-gpu-layers`, `gpu-layers` and `ngl` all work; `-ngl` and the
 * `LLAMA_ARG_*` names do not); a flag takes `true` or `false`; a model's section
 * overrides `[*]`, and a `[*]` key reaches every model's own process. A value is
 * not checked until a model loads: `keep = banana` boots, then fails that load
 * with `error while handling argument "--keep": stoi: no conversion`, which the
 * load-failure explanation already reports.
 */

export interface OptionGroup {
  /** Every name the option answers to, without dashes, as `--help` lists them. */
  names: string[];
  /** Whether `--help` shows a value after the names. A flag takes true/false. */
  takesValue: boolean;
  description: string;
}

export interface OptionList {
  groups: OptionGroup[];
  byName: Map<string, OptionGroup>;
}

export interface ExtraOption {
  key: string;
  value: string;
}

export class ExtraOptionError extends LoadSettingsError {
  /** The row the error is about, or null for the list as a whole. */
  readonly index: number | null;
  constructor(message: string, index: number | null) {
    super(message);
    this.name = "ExtraOptionError";
    this.index = index;
  }
}

export const MAX_EXTRA_OPTIONS = 32;
const MAX_VALUE = 1024;
const MAX_HELP_BYTES = 1024 * 1024;
const MAX_LINE = 4096;
const MAX_DESCRIPTION = 600;
/** What a key may look like: one INI key, so nothing that could end it early
 * (`=`, whitespace) or start a comment or a section. Case matters: `-c` is the
 * context size and `-C` the CPU mask. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Read `llama-server --help` into option groups.
 *
 * The layout (b11342): an option starts a line at column 0 with its names,
 * separated by ", " (`-ngl,  --gpu-layers, --n-gpu-layers N`), then the value's
 * placeholder if it takes one, then two or more spaces and the description.
 * When the names are too long for the column, the description starts on the
 * next line. Continuation lines are indented. A placeholder can hold commas
 * and spaces of its own (`<tensor name pattern>=<buffer type>,...`), but never
 * ", ", which is what separates names.
 *
 * One pass over the lines with no backtracking pattern: the text comes from a
 * binary an admin may have downloaded from anyone.
 */
export function parseHelp(text: string): OptionList {
  const groups: OptionGroup[] = [];
  const byName = new Map<string, OptionGroup>();
  let current: OptionGroup | null = null;
  const body = text.length > MAX_HELP_BYTES ? text.slice(0, MAX_HELP_BYTES) : text;
  for (const raw of body.split("\n")) {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw.replace(/\r$/, "");
    if (line.startsWith("-----")) {
      current = null;
      continue;
    }
    if (line.startsWith("-")) {
      const end = headEnd(line);
      const group = parseHead(line.slice(0, end));
      current = null;
      if (!group) continue;
      group.description = line.slice(end).trim();
      groups.push(group);
      for (const name of group.names) if (!byName.has(name)) byName.set(name, group);
      current = group;
      continue;
    }
    if (current && /^\s/.test(line) && line.trim()) {
      if (current.description.length < MAX_DESCRIPTION) {
        current.description = `${current.description} ${line.trim()}`.trim().slice(0, MAX_DESCRIPTION);
      }
      continue;
    }
    if (!line.trim()) current = null;
  }
  return { groups, byName };
}

/** Where an option line's names (and placeholder) end and its description
 * starts: the first run of two or more spaces that does not follow a comma. */
function headEnd(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== " " || line[i + 1] !== " ") continue;
    let j = i;
    while (j < line.length && line[j] === " ") j++;
    if (line[i - 1] === ",") {
      i = j - 1;
      continue;
    }
    return i;
  }
  return line.length;
}

function parseHead(head: string): OptionGroup | null {
  const names: string[] = [];
  let takesValue = false;
  for (const piece of head.split(/,\s+/)) {
    const trimmed = piece.trim();
    if (!trimmed.startsWith("-")) {
      // Part of the placeholder, after a ", " inside it.
      if (names.length > 0 && trimmed) takesValue = true;
      continue;
    }
    const space = trimmed.indexOf(" ");
    const flag = space < 0 ? trimmed : trimmed.slice(0, space);
    if (space >= 0 && trimmed.slice(space).trim()) takesValue = true;
    const name = flag.replace(/^-+/, "");
    if (KEY.test(name)) names.push(name);
  }
  return names.length > 0 ? { names, takesValue, description: "" } : null;
}

// ── What an admin may not set ───────────────────────────────────────────────

const LOG =
  "Loxaic reads llama.cpp's log to explain failed loads and show where a model's memory went, and keeps prompts out of it.";
const NETWORK = "It reaches outside this machine's model files (a download, a network service, or files written elsewhere).";
const WIRING = "Loxaic runs the llama.cpp router with this itself.";
const EXITS = "It makes llama.cpp print something and exit instead of serving.";

/** Options refused by name, through every alias of the group that has one. */
const RESERVED: ReadonlyMap<string, string> = new Map<string, string>([
  ...LOAD_SETTINGS.map((s): [string, string] => [s.flag, `Loxaic sets this from the model's "${s.label}" setting. Use that instead.`]),
  ["model", "Loxaic sets the model's file itself."],
  ["mmproj", "Loxaic sets the vision projector itself. Use the model's Vision setting."],
  ["jinja", "Loxaic needs the model's own chat template for tool calls."],
  ["device", 'Choose devices with "GPUs to use" on the runtime card.'],
  ["lazy-mode", "Loxaic sets this from the model's lookup-table setting."],
  ["load-mode", "Loxaic sets this from the model's memory-mapping setting."],
  ["spec-type", "Loxaic sets this from the model's multi-token prediction setting."],
  ["spec-draft-model", "Loxaic sets this from the model's multi-token prediction setting."],
  ["spec-draft-n-max", "Loxaic sets this from the model's multi-token prediction setting."],
  ...["rope-scaling", "rope-scale", "yarn-orig-ctx", "yarn-ext-factor", "yarn-attn-factor", "yarn-beta-slow", "yarn-beta-fast"].map(
    (k): [string, string] => [k, "Loxaic sets this from the model's context stages. Use those instead."],
  ),
  ...["host", "port", "models-preset", "models-max", "models-dir", "models-autoload", "api-key", "api-key-file", "alias", "api-prefix", "reuse-port"].map(
    (k): [string, string] => [k, WIRING],
  ),
  ["embedding", "It would stop the model answering chats."],
  ["rerank", "It would stop the model answering chats."],
  ...[
    "log-file",
    "log-prompts-dir",
    "slot-save-path",
    "path",
    "media-path",
    "ssl-key-file",
    "ssl-cert-file",
    "hf-repo",
    "hf-file",
    "hf-token",
    "hf-repo-draft",
    "model-url",
    "mmproj-url",
    "docker-repo",
    "rpc",
    "tools",
    "tools-runtime",
    "agent",
    "mcp-servers-config",
    "mcp-servers-json",
    "ui-mcp-proxy",
    "video-ffmpeg-dir",
  ].map((k): [string, string] => [k, NETWORK]),
  ["verbose", LOG],
  ["verbosity", LOG],
  ...["help", "version", "list-devices", "cache-list", "completion-bash"].map((k): [string, string] => [k, EXITS]),
]);

/** Why an option may not be set here, or null when it may. */
export function reservedReason(group: OptionGroup): string | null {
  for (const name of group.names) {
    const plain = name.startsWith("no-") ? name.slice(3) : name;
    const reason = RESERVED.get(name) ?? RESERVED.get(plain);
    if (reason) return reason;
    if (plain.startsWith("log-")) return LOG;
  }
  const d = group.description.toLowerCase();
  if (d.includes("download")) return NETWORK;
  if (d.includes("has been removed")) return "llama.cpp has removed this option.";
  return null;
}

// ── Validating and rendering rows ───────────────────────────────────────────

function cleanKey(raw: string): string {
  return raw.trim().replace(/^-+/, "");
}

/**
 * Check an admin's rows against the build that will read them, and return
 * them as stored: keys without dashes, flag values lowercased, values trimmed.
 * The key is kept as typed, not swapped for another name of the same option:
 * `no-warmup = true` and `warmup = true` mean opposite things.
 *
 * `kept` is what is stored now. A stored row this build does not know (it was
 * set under another version) may stay as it is: it is not passed while this
 * build runs, and the admin is told so, but refusing it would block saving
 * anything else beside it. Changing it, or adding one, needs a known key.
 */
export function normalizeExtraOptions(raw: unknown, options: OptionList, kept: readonly ExtraOption[] = []): ExtraOption[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ExtraOptionError("Extra options must be a list of { key, value }", null);
  if (raw.length > MAX_EXTRA_OPTIONS) {
    throw new ExtraOptionError(`At most ${String(MAX_EXTRA_OPTIONS)} extra options can be set`, null);
  }
  const out: ExtraOption[] = [];
  const seen = new Map<OptionGroup, string>();
  const seenUnknown = new Set<string>();
  raw.forEach((row: unknown, index) => {
    if (typeof row !== "object" || row === null) throw new ExtraOptionError("Each option needs a key and a value", index);
    const r = row as Record<string, unknown>;
    if (typeof r.key !== "string" || (r.value !== undefined && typeof r.value !== "string")) {
      throw new ExtraOptionError("Each option needs a key and a value", index);
    }
    const key = cleanKey(r.key);
    if (!key) throw new ExtraOptionError("Type the option's name", index);
    if (!KEY.test(key)) throw new ExtraOptionError(`"${key}" is not an option name`, index);
    const group = options.byName.get(key);
    if (!group) {
      const value = typeof r.value === "string" ? r.value.trim() : "";
      if (kept.some((k) => k.key === key && k.value === value) && !seenUnknown.has(key)) {
        seenUnknown.add(key);
        out.push({ key, value });
        return;
      }
      throw new ExtraOptionError(`This llama.cpp build has no option "${key}"`, index);
    }
    const reserved = reservedReason(group);
    if (reserved) throw new ExtraOptionError(`"${key}" can't be set here. ${reserved}`, index);
    const earlier = seen.get(group);
    if (earlier !== undefined) {
      throw new ExtraOptionError(
        earlier === key ? `"${key}" is set twice` : `"${key}" is the same option as "${earlier}", set above`,
        index,
      );
    }
    seen.set(group, key);
    const value = checkValue(key, group, typeof r.value === "string" ? r.value : "", index);
    out.push({ key, value });
  });
  return out;
}

function checkValue(key: string, group: OptionGroup, raw: string, index: number): string {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000]/.test(raw)) throw new ExtraOptionError("A value must be on one line", index);
  const value = raw.trim();
  if (value.length > MAX_VALUE) throw new ExtraOptionError(`A value can be at most ${String(MAX_VALUE)} characters`, index);
  if (!group.takesValue) {
    const v = value.toLowerCase();
    if (v !== "true" && v !== "false") throw new ExtraOptionError(`"${key}" is a switch: its value is true or false`, index);
    return v;
  }
  if (!value) throw new ExtraOptionError(`"${key}" needs a value`, index);
  return value;
}

/**
 * The preset lines for stored rows, as the build that will read them sees
 * them. A row it no longer accepts (a version switched to later, a stored row
 * that came by another route) is left out and named in `skipped`, so the
 * router still starts. With no option list at all, every row is skipped: a
 * key nobody could check is exactly the one that stops the router.
 */
export function extraOptionLines(rows: readonly ExtraOption[] | null | undefined, options: OptionList | null): { lines: string[]; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<OptionGroup>();
  for (const row of rows ?? []) {
    const group = options?.byName.get(row.key);
    // eslint-disable-next-line no-control-regex
    let ok = Boolean(group) && KEY.test(row.key) && !/[\r\n\u0000]/.test(row.value);
    if (group && ok) {
      ok = reservedReason(group) === null && !seen.has(group) && (group.takesValue ? row.value.trim() !== "" : row.value === "true" || row.value === "false");
    }
    if (!ok || !group) {
      skipped.push(row.key);
      continue;
    }
    seen.add(group);
    lines.push(`${row.key} = ${row.value}`);
  }
  return { lines, skipped };
}

/** Stored rows as data: anything not shaped like one is dropped on the way in.
 * Whether a row's key is known is decided when it is rendered. */
export function coerceExtraOptions(raw: unknown): ExtraOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is ExtraOption => typeof r === "object" && r !== null && typeof (r as ExtraOption).key === "string" && typeof (r as ExtraOption).value === "string")
    .slice(0, MAX_EXTRA_OPTIONS)
    .map((r) => ({ key: r.key, value: r.value }));
}

/** What the client is told about each option, to check rows as they are typed
 * and say what an option does. */
export interface OptionView {
  names: string[];
  takesValue: boolean;
  description: string;
  /** Why it may not be set here, or null. */
  reserved: string | null;
}

export function optionViews(options: OptionList): OptionView[] {
  return options.groups.map((g) => ({ names: g.names, takesValue: g.takesValue, description: g.description, reserved: reservedReason(g) }));
}
