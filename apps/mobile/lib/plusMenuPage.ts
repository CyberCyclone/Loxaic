/**
 * Which page the native `+` sheet shows. Explicit rather than positional: a
 * page whose content went away while it was open (the model's thinking control
 * disappearing on a model switch, the MCP switches unmounting) falls back to
 * the main page, never to whichever page happens to be last in the chain —
 * which was the MCP list, opened for someone who never asked for it.
 */
export type PlusMenuPage = 'main' | 'mcp' | 'thinking';

export function plusMenuPage(page: PlusMenuPage, has: { thinking: boolean; mcp: boolean }): PlusMenuPage {
  if (page === 'thinking' && has.thinking) return 'thinking';
  if (page === 'mcp' && has.mcp) return 'mcp';
  return 'main';
}
