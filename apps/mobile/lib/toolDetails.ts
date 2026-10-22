/** One argument of a tool call, as the details view shows it (#267). */
export interface ToolDetailField {
  /** The argument's own name — stable, and what testIDs carry. */
  key: string;
  label: string;
  value: string;
  /** Code-like (a command, a path, file content), set in monospace. */
  mono: boolean;
}

/**
 * The arguments each built-in tool is known to take, in the order a person
 * reads them, with a friendlier label. Mirrors `packages/agent/src/index.ts`.
 * Anything else a call carries — an MCP tool's arguments, or a key a model
 * added — follows as it came, so the view never hides part of a call.
 */
const KNOWN: Record<string, readonly (readonly [key: string, label: string, mono: boolean])[]> = {
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
 * Every argument of a call, in full: nothing is cut, since the point is to
 * see exactly what the tool is about to do. An argument that is absent is
 * left out, not shown empty. Empty args give no fields at all.
 */
export function toolDetailFields(tool: string, args: Record<string, unknown> | undefined): ToolDetailField[] {
  if (!args) return [];
  const known = KNOWN[tool] ?? [];
  const fields: ToolDetailField[] = [];
  for (const [key, label, mono] of known) {
    if (args[key] === undefined) continue;
    fields.push({ key, label, value: show(args[key]), mono });
  }
  const knownKeys = new Set(known.map(([key]) => key));
  for (const [key, value] of Object.entries(args)) {
    if (knownKeys.has(key) || value === undefined) continue;
    fields.push({ key, label: key, value: show(value), mono: true });
  }
  return fields;
}
