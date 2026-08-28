import { useCallback, useEffect, useState } from 'react';
import { getConversations, getMcpServers, updateConversation, type McpServer } from '@shannon/api-client';
import { useToastHelper } from './useToastHelper';

/**
 * Per-conversation MCP server switches (Inspector). Server-authoritative:
 * reads the user's enabled servers plus the conversation's stored
 * mcpOverrides, writes back through the conversations PATCH. Takes effect on
 * the conversation's next run — the toolset is built once per run.
 */
export function useMcpOverrides(token: string | null, conversationId: string | null) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const { showToast } = useToastHelper();

  useEffect(() => {
    if (!token) return;
    // A field rather than a plain `let`: the cleanup below flips this from a
    // different closure, which the type checker doesn't model — it would
    // narrow a local to a stale `false` and treat both guards as dead. A
    // property read is never narrowed that way (same reasoning as the
    // engine's isAborted indirection).
    const live = { cancelled: false };
    void (async () => {
      try {
        const [allServers, convs] = await Promise.all([getMcpServers(), getConversations()]);
        if (live.cancelled) return;
        setServers(allServers.filter((s) => s.enabled));
        const conv = conversationId ? convs.find((c) => c.id === conversationId) : undefined;
        setDisabledIds(conv?.mcpOverrides?.disabledServerIds ?? []);
      } catch {
        if (!live.cancelled) setServers([]);
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [token, conversationId]);

  const toggle = useCallback(
    (serverId: string, disabled: boolean) => {
      if (!conversationId) return;
      const next = disabled ? [...new Set([...disabledIds, serverId])] : disabledIds.filter((id) => id !== serverId);
      setDisabledIds(next);
      updateConversation(conversationId, { mcp_overrides: { disabledServerIds: next } }).catch(() => {
        setDisabledIds(disabledIds);
        showToast('Could not update MCP settings for this conversation');
      });
    },
    [conversationId, disabledIds, showToast],
  );

  return { servers, disabledIds, toggle };
}
