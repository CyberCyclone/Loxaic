import type { PermissionMode } from '@loxaic/api-client';

/** MCP tools arrive namespaced as `server__tool`; builtins never contain `__`. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) };
}

export interface PermissionBarView {
  mcp: { server: string; tool: string } | null;
  /** Whether "Allow always" is offered to this person at all. */
  canAllowAlways: boolean;
  /** Which accepting button is the filled one. */
  primary: 'once' | 'always';
  /** Why an auto run is asking, and what "Allow always" changes. */
  note: string | null;
}

/**
 * What the agent's permission bar offers (#266), from facts about the run that
 * is asking, never from the mode selector. The selector is the next message's
 * mode, resets to Manual on a reload and can be tapped while a run is parked:
 * read from it, the bar promised a standing grant on a manual run and hid one
 * on an auto run.
 *
 * "Allow always" is offered only to the person the server will record it for,
 * `granterUserId` (whoever sent the run). An editor on a shared conversation
 * can answer the call, and a server that predates the field ignores the
 * request, so neither is shown a button that would do less than it says.
 *
 * The buttons mean the same thing in every mode. In an auto run asking about
 * an MCP tool, "Allow always" is the filled one, because the prompt exists
 * only until that tool has been allowed.
 */
export function permissionBarView(
  approval: { tool: string; mode?: PermissionMode; granterUserId?: string },
  viewerUserId: string | null | undefined,
): PermissionBarView {
  const mcp = splitMcpTool(approval.tool);
  const canAllowAlways = approval.granterUserId != null && approval.granterUserId === viewerUserId;
  if (mcp && approval.mode === 'auto' && canAllowAlways) {
    return {
      mcp,
      canAllowAlways,
      primary: 'always',
      note:
        `Auto mode asks before an MCP tool is first used. “Allow always” lets ${mcp.tool} ` +
        `from ${mcp.server} run without asking from now on, in every conversation and mode.`,
    };
  }
  return { mcp, canAllowAlways, primary: 'once', note: null };
}
