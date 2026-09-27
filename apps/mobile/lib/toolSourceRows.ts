import type { ContextToolSource } from '@loxaic/types';
import type { McpSwitchRow } from './mcpSwitches';

/**
 * The rows under "Tool definitions" in the context popup: what each source's
 * schemas cost in the last request, merged with what the switches say now.
 *
 * The figures are a fact about the last request and the switches are a fact
 * about the next one, so the two are allowed to disagree — and each row says
 * which way, rather than silently showing a cost that no longer applies.
 */

export interface ToolSourceRow {
  /** `"builtin"`, or the MCP server's id. */
  key: string;
  kind: 'builtin' | 'mcp';
  name: string;
  /** Tokens in the last request; null for a server it did not include. */
  tokens: number | null;
  tools: number | null;
  /** On for the next request. Null for builtins, which have no switch. */
  on: boolean | null;
  /** Whether a switch is shown — only for servers this conversation could be
   * offered (globally enabled ones). */
  switchable: boolean;
  /** Set when the last request's figure no longer describes the next one. */
  note: string | null;
}

const fmt = (n: number) => n.toLocaleString();

export function toolSourceRows(sources: ContextToolSource[], switches: McpSwitchRow[]): ToolSourceRow[] {
  const byId = new Map(switches.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows: ToolSourceRow[] = sources.map((src) => {
    seen.add(src.key);
    if (src.kind === 'builtin') {
      return { key: src.key, kind: 'builtin', name: src.name, tokens: src.tokens, tools: src.tools, on: null, switchable: false, note: null };
    }
    const sw = byId.get(src.key);
    // A server no longer in the list was switched off everywhere or removed:
    // it will not be offered next time either.
    const on = sw?.on ?? false;
    return {
      key: src.key,
      kind: 'mcp',
      name: sw?.name ?? src.name,
      tokens: src.tokens,
      tools: src.tools,
      on,
      switchable: sw !== undefined,
      note: on ? null : `Off · frees ~${fmt(src.tokens)} tokens from your next message`,
    };
  });
  for (const sw of switches) {
    if (seen.has(sw.id) || !sw.on) continue;
    rows.push({
      key: sw.id,
      kind: 'mcp',
      name: sw.name,
      tokens: null,
      tools: null,
      on: true,
      switchable: true,
      note: 'On · counted from your next message',
    });
  }
  // Builtins first, then the most expensive server, and servers with no
  // figure yet last.
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'builtin' ? -1 : 1;
    return (b.tokens ?? -1) - (a.tokens ?? -1);
  });
}
