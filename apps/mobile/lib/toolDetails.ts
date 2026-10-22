/** One argument of a tool call, as the details view shows it (#267). */
export interface ToolDetailField {
  /** The argument's own name — stable, and what testIDs carry. */
  key: string;
  label: string;
  value: string;
  /** Code-like (a command, a path, file content), set in monospace. */
  mono: boolean;
  /** Characters past `MAX_DETAIL_CHARS` that are not shown; 0 for all. */
  more: number;
}

/**
 * The most of one argument the view renders. A whole multi-megabyte file in
 * one Text node stalls the sheet (and blanks it on Android); past this the
 * view says how much it left out, so a person can still refuse a call whose
 * tail they cannot see.
 */
export const MAX_DETAIL_CHARS = 20_000;

/** Escapes for the C0 controls people know by a letter. */
const NAMED: Record<string, string> = { '\r': '\\r', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\0': '\\0' };

/**
 * Controls and invisible formatting characters, which make what is shown
 * differ from what runs: a carriage return or backspace that redraws a
 * terminal line, a bidi override (U+202E) that reverses the text after it,
 * zero-width characters that hide inside a word. Tab and newline are left —
 * they lay text out and are seen as such.
 */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Shows every hidden character as a visible escape (`\r`, `\x1b`,
 * `\u202E`), so the text a person approves from is the text that runs.
 */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => {
    const named = NAMED[ch];
    if (named) return named;
    const code = ch.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** At most `MAX_DETAIL_CHARS`, never splitting a surrogate pair. */
function cap(text: string): { value: string; more: number } {
  if (text.length <= MAX_DETAIL_CHARS) return { value: text, more: 0 };
  let end = MAX_DETAIL_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { value: text.slice(0, end), more: text.length - end };
}

/**
 * The arguments each built-in tool is known to take, in the order a person
 * reads them, with a friendlier label. Mirrors `packages/agent/src/index.ts`
 * (a test holds it to that). Anything else a call carries — an MCP tool's
 * arguments, or a key a model added — follows as it came, so the view never
 * hides part of a call.
 */
export const KNOWN_ARGS: Record<string, readonly (readonly [key: string, label: string, mono: boolean])[]> = {
  bash: [['command', 'Command', true]],
  fs_read: [
    ['path', 'Path', true],
    ['offset', 'From line', false],
    ['limit', 'Lines', false],
  ],
  fs_write: [
    ['path', 'Path', true],
    ['content', 'Content', true],
  ],
  fs_edit: [
    ['path', 'Path', true],
    ['oldText', 'Replace', true],
    ['newText', 'With', true],
  ],
  grep: [
    ['pattern', 'Pattern', true],
    ['path', 'In', true],
  ],
  glob: [
    ['pattern', 'Pattern', true],
    ['path', 'In', true],
  ],
  web_fetch: [['url', 'URL', true]],
};

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  // Typed as a string, but undefined for a function or a symbol.
  const json = JSON.stringify(value, null, 2) as string | undefined;
  return json ?? String(value);
}

/**
 * Every argument of a call, with nothing hidden: the point is to see exactly
 * what the tool is about to do. Hidden characters are made visible, and only
 * a value past `MAX_DETAIL_CHARS` is cut, saying by how much. An argument
 * that is absent is left out, not shown empty. Empty args give no fields.
 */
export function toolDetailFields(tool: string, args: Record<string, unknown> | undefined): ToolDetailField[] {
  if (!args) return [];
  const known = KNOWN_ARGS[tool] ?? [];
  const fields: ToolDetailField[] = [];
  for (const [key, label, mono] of known) {
    if (args[key] === undefined) continue;
    fields.push({ key, label, mono, ...cap(revealHidden(show(args[key]))) });
  }
  const knownKeys = new Set(known.map(([key]) => key));
  for (const [key, value] of Object.entries(args)) {
    if (knownKeys.has(key) || value === undefined) continue;
    fields.push({ key, label: revealHidden(key), mono: true, ...cap(revealHidden(show(value))) });
  }
  return fields;
}
