/**
 * Whether an MCP server's tools are offered to one conversation.
 *
 * Shared by the server (which decides what a run is offered) and the client
 * (which shows the switches), so the two can never disagree about a server's
 * state. The order is:
 *
 *   1. the conversation's own choice — `disabledServerIds` first, so a server
 *      somehow in both lists is off, then `enabledServerIds`;
 *   2. otherwise the server's default for the conversation's kind.
 *
 * A server that is not globally enabled never reaches this function: that
 * filter is applied before it, on both sides.
 *
 * Defaults resolve live rather than being copied into a conversation when it
 * is created, so changing a server's Chat default applies to every chat that
 * has not made its own choice. A switch flipped in a chat is always stored as
 * an explicit choice, even when it happens to match the default.
 */

export type McpConversationKind = "chat" | "agent" | "routine";

/** Per-conversation overrides, as stored in `conversations.mcp_overrides`.
 * Rows written before `enabledServerIds` existed carry only the first list. */
export interface McpOverrides {
  disabledServerIds?: string[];
  enabledServerIds?: string[];
}

/** A server's per-user default for each kind of conversation. */
export interface McpSurfaceDefaults {
  onInChat: boolean;
  onInAgent: boolean;
  onInRoutines: boolean;
}

export function mcpDefaultFor(server: McpSurfaceDefaults, kind: McpConversationKind): boolean {
  switch (kind) {
    case "agent":
      return server.onInAgent;
    case "routine":
      return server.onInRoutines;
    default:
      return server.onInChat;
  }
}

/** Whether this conversation made its own choice about the server, and which. */
export function mcpExplicitChoice(serverId: string, overrides: McpOverrides | null | undefined): boolean | null {
  if (overrides?.disabledServerIds?.includes(serverId)) return false;
  if (overrides?.enabledServerIds?.includes(serverId)) return true;
  return null;
}

export function mcpServerActive(
  server: McpSurfaceDefaults & { id: string },
  kind: McpConversationKind,
  overrides: McpOverrides | null | undefined,
): boolean {
  return mcpExplicitChoice(server.id, overrides) ?? mcpDefaultFor(server, kind);
}

/** Overrides with `serverId` explicitly set to `on`, removed from the other list. */
export function withMcpChoice(overrides: McpOverrides | null | undefined, serverId: string, on: boolean): McpOverrides {
  const disabled = (overrides?.disabledServerIds ?? []).filter((id) => id !== serverId);
  const enabled = (overrides?.enabledServerIds ?? []).filter((id) => id !== serverId);
  (on ? enabled : disabled).push(serverId);
  return { disabledServerIds: disabled, enabledServerIds: enabled };
}

/** Coerce an untrusted `mcp_overrides` value (a request body, a jsonb column)
 * to the stored shape: two string arrays, de-duplicated, and a server named in
 * both lists kept only as disabled. Returns null for anything that is not an
 * object, so a caller can tell "sent nothing usable" from "sent empty lists". */
export function normalizeMcpOverrides(value: unknown): McpOverrides | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" || typeof x === "number").map(String))] : [];
  const disabled = list(raw.disabledServerIds);
  const off = new Set(disabled);
  const enabled = list(raw.enabledServerIds).filter((id) => !off.has(id));
  return { disabledServerIds: disabled, enabledServerIds: enabled };
}
