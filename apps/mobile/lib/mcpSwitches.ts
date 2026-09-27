import {
  mcpExplicitChoice,
  mcpServerActive,
  withMcpChoice,
  type McpConversationKind,
  type McpOverrides,
} from '@loxaic/types';
import type { McpServer } from '@loxaic/api-client';
import { isServerConvId } from './streamMessages';

/**
 * The per-conversation MCP switches, as the composer's `+` menu, the context
 * popup and the agent Inspector all show them. Pure, so the rules are unit
 * tested; `hooks/useMcpSwitches.ts` is the state around them.
 *
 * Whether a server is on is `mcpServerActive` (packages/types) — the same
 * function the server's registry applies to the next run.
 */

export interface McpSwitchRow {
  id: string;
  name: string;
  /** Tools the server has reported so far; 0 until it has connected once. */
  toolCount: number;
  lastError: string | null;
  /** Offered to this conversation's next request. */
  on: boolean;
  /** This conversation made its own choice, rather than following the
   * server's default for its kind. */
  explicit: boolean;
}

/** A server that predates the per-kind defaults is on everywhere. */
export function serverDefaults(server: Pick<McpServer, 'onInChat' | 'onInAgent' | 'onInRoutines'>) {
  return {
    onInChat: server.onInChat ?? true,
    onInAgent: server.onInAgent ?? true,
    onInRoutines: server.onInRoutines ?? true,
  };
}

/** Rows for the servers a conversation could be offered: globally enabled
 * ones only, in the order the server lists them. */
export function switchRows(
  servers: McpServer[],
  kind: McpConversationKind,
  overrides: McpOverrides | null | undefined,
): McpSwitchRow[] {
  return servers
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      toolCount: Object.keys(s.knownTools).length,
      lastError: s.lastError,
      on: mcpServerActive({ id: s.id, ...serverDefaults(s) }, kind, overrides),
      explicit: mcpExplicitChoice(s.id, overrides) !== null,
    }));
}

/**
 * Where a toggle goes. A conversation that does not exist on the server yet —
 * no id, or a local placeholder (`c<ts>`, `pending-*`) — holds its choices on
 * the client until its first send carries them; one that exists is PATCHed.
 */
export function toggleTarget(conversationId: string | null): 'pending' | 'patch' {
  return conversationId !== null && isServerConvId(conversationId) ? 'patch' : 'pending';
}

export function applyToggle(
  overrides: McpOverrides | null | undefined,
  serverId: string,
  on: boolean,
): McpOverrides {
  return withMcpChoice(overrides, serverId, on);
}

/** What a first send should carry: nothing when no choice was made, so an
 * ordinary send stays byte-identical to what it was. */
export function overridesToSend(pending: McpOverrides | null | undefined): McpOverrides | undefined {
  if (!pending) return undefined;
  const any = (pending.disabledServerIds?.length ?? 0) + (pending.enabledServerIds?.length ?? 0) > 0;
  return any ? pending : undefined;
}

/** A local placeholder the session swapped for the server's id, as it
 * announced in `turn.started`. */
export interface Promotion {
  localId: string;
  realId: string;
}

/**
 * Whether the choices held for an unsent conversation belong to the one now on
 * screen. Only when the session promoted exactly that placeholder into exactly
 * this id: leaving an unsent new chat for an existing thread looks the same
 * from the ids alone (pending → a server id), and applying the abandoned
 * choices there would overwrite that thread's own.
 */
export function carriesChoices(
  previousId: string | null | undefined,
  nextId: string | null,
  promotion: Promotion | null | undefined,
): boolean {
  return (
    !!promotion &&
    previousId !== null &&
    previousId !== undefined &&
    previousId === promotion.localId &&
    nextId === promotion.realId
  );
}
