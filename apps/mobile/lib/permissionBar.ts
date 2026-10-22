import type { PermissionCheckNote, PermissionMode, ToolPermission } from '@loxaic/api-client';
import { MODE_LABELS } from './modeSelector';

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
  /** What "Allow always" says it records: the command rules for `bash`
   * ("Always allow `gh pr view *`"). Null for the plain button. */
  alwaysLabel: string | null;
  /** Why auto mode's permission check sent this to a person. Shown whatever
   * else is offered. */
  checkNote: string | null;
  /** The asking run's mode, said when the selector says another (#311). */
  modeNote: string | null;
}

/**
 * The line naming the asking run's mode, when the selector says another
 * (#311): a pick of Planning waits for the next message, and an older server
 * switches no run at all. The run's mode is the approval's own, never the
 * selector's; null when either is unknown or they agree.
 */
export function runModeNote(runMode: PermissionMode | undefined, selectorMode: PermissionMode | undefined): string | null {
  if (!runMode || !selectorMode || runMode === selectorMode) return null;
  return `This run is in ${MODE_LABELS[runMode]} mode. ${MODE_LABELS[selectorMode]} applies from your next message.`;
}

/** The sentence for a permission check that asked instead of answering. */
export function permissionCheckNote(check: PermissionCheckNote | undefined): string | null {
  if (!check) return null;
  switch (check.outcome) {
    case 'ask':
      return check.reason
        ? `Auto mode's permission check asked you: ${check.reason}`
        : "Auto mode's permission check wasn't sure, so it is asking you.";
    case 'timeout':
      return "Auto mode's permission check took too long, so it is asking you.";
    case 'unparseable':
      return "Auto mode's permission check gave no clear answer, so it is asking you.";
    case 'error':
      return "Auto mode's permission check could not run, so it is asking you.";
  }
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
 * For `bash` it is offered only with the command rules the server proposed
 * (`rules`), and says which: a grant is a rule like `gh pr view *`, never the
 * whole tool. No rules — a command no rule can say exactly, or a server that
 * predates them — and there is no standing grant to offer.
 *
 * The buttons mean the same thing in every mode. In an auto run asking about
 * an MCP tool, "Allow always" is the filled one, because the prompt exists
 * only until that tool has been allowed.
 */
export function permissionBarView(
  approval: {
    tool: string;
    mode?: PermissionMode;
    granterUserId?: string;
    rules?: string[];
    check?: PermissionCheckNote;
  },
  viewerUserId: string | null | undefined,
  /** The selector, only to say when the run's mode is not what it shows. */
  selectorMode?: PermissionMode,
): PermissionBarView {
  const mcp = splitMcpTool(approval.tool);
  const checkNote = permissionCheckNote(approval.check);
  const modeNote = runModeNote(approval.mode, selectorMode);
  const isGranter = approval.granterUserId != null && approval.granterUserId === viewerUserId;
  if (approval.tool === 'bash') {
    const rules = approval.rules ?? [];
    const canAllowAlways = isGranter && rules.length > 0;
    return {
      mcp: null,
      canAllowAlways,
      primary: 'once',
      note: null,
      alwaysLabel: canAllowAlways ? `Always allow ${rules.map((r) => `\`${r}\``).join(' and ')}` : null,
      checkNote,
      modeNote,
    };
  }
  if (mcp && approval.mode === 'auto' && isGranter) {
    return {
      mcp,
      canAllowAlways: true,
      primary: 'always',
      note:
        `Auto mode asks before an MCP tool is first used. “Allow always” lets ${mcp.tool} ` +
        `from ${mcp.server} run without asking from now on, in every conversation and mode.`,
      alwaysLabel: null,
      checkNote,
      modeNote,
    };
  }
  return { mcp, canAllowAlways: isGranter, primary: 'once', note: null, alwaysLabel: null, checkNote, modeNote };
}

/**
 * The line under a tool call that ran, or was refused, without anyone being
 * asked — so "it just ran" always says why. Null when a person approved it
 * (nothing to explain) or the server did not say.
 */
export function permissionBadge(permission: ToolPermission | undefined): string | null {
  if (!permission) return null;
  switch (permission.by) {
    case 'readonly':
      return 'Read-only command · ran without asking';
    case 'rule':
      return permission.rule ? `Allowed by your rule \`${permission.rule}\`` : 'Allowed by your command rules';
    case 'isolated':
      return 'Ran without asking · sandbox has no network';
    case 'classifier':
      return permission.reason ? `Allowed by the permission check · ${permission.reason}` : 'Allowed by the permission check';
    case 'denied':
      return permission.rule ? `Denied by your rule \`${permission.rule}\`` : 'Denied by your command rules';
    case 'refused':
      return 'Refused · planning mode runs only read-only commands';
  }
}
