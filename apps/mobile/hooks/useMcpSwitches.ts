import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConversation, getMcpServers, updateConversation, type McpServer } from '@loxaic/api-client';
import type { McpConversationKind, McpOverrides } from '@loxaic/types';
import { useServerReachable } from '@/lib/connection';
import {
  applyToggle,
  carriesChoices,
  overridesToSend,
  switchRows,
  toggleTarget,
  type McpSwitchRow,
  type Promotion,
} from '@/lib/mcpSwitches';
import { useToastHelper } from './useToastHelper';

export interface McpSwitches {
  rows: McpSwitchRow[];
  /** Still learning the servers or this conversation's choices. */
  loading: boolean;
  /** Why the switches cannot be used here, when they cannot. Offline is not
   * one of these: that is `reachable`, and it passes. */
  lockedReason: string | null;
  /** Switches may be pressed: loaded, editable, and the server reachable. */
  canToggle: boolean;
  toggle: (serverId: string, on: boolean) => void;
  /** Re-read the server list — the menu calls this each time it opens, since
   * servers are added and switched off on another screen. */
  refresh: () => void;
  /** Choices made before the conversation existed, for its first send (or the
   * create call) to carry. Undefined when there are none. */
  pendingOverrides: McpOverrides | undefined;
}

const EMPTY: McpOverrides = { disabledServerIds: [], enabledServerIds: [] };

function sameOverrides(a: McpOverrides | null | undefined, b: McpOverrides | null | undefined): boolean {
  const key = (o: McpOverrides | null | undefined) =>
    JSON.stringify([[...(o?.disabledServerIds ?? [])].sort(), [...(o?.enabledServerIds ?? [])].sort()]);
  return key(a) === key(b);
}

/**
 * The MCP servers one conversation is offered, and a switch for each. One
 * instance per screen, shared by the composer's `+` menu, the context popup
 * and (on Agent) the Inspector, so none of them can disagree.
 *
 * Before the conversation exists its choices are held here and ride its first
 * send (`pendingOverrides`); once it has a server id they are PATCHed. When a
 * conversation first gets its real id and the server's row does not have the
 * choices made meanwhile — an older server that ignores them on the send, or
 * a switch flipped while the send was in flight — they are PATCHed then.
 * "Gets its real id" is the session's `promotion`, never an inference from the
 * ids: leaving an unsent new chat for an existing thread also goes from
 * pending to a server id, and must drop the choices rather than apply them.
 */
export function useMcpSwitches(
  token: string | null,
  conversationId: string | null,
  kind: McpConversationKind,
  promotion?: Promotion | null,
): McpSwitches {
  const reachable = useServerReachable();
  const { showToast } = useToastHelper();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [overrides, setOverrides] = useState<McpOverrides | null>(EMPTY);
  const [convLoaded, setConvLoaded] = useState(true);
  const [isOwner, setIsOwner] = useState(true);
  const [serversTick, setServersTick] = useState(0);
  // Read by callbacks that must not re-create on every toggle.
  const overridesRef = useRef<McpOverrides | null>(overrides);
  overridesRef.current = overrides;
  const target = toggleTarget(conversationId);
  // `undefined` so the first render always runs the effect below, including
  // for a screen that opens straight onto an existing conversation.
  const prev = useRef<{ id: string | null | undefined; target: 'pending' | 'patch' }>({ id: undefined, target: 'pending' });
  // Read inside the effect below, which must not re-run when only this changes:
  // the session sets it in the same update that moves `conversationId`.
  const promotionRef = useRef(promotion);
  promotionRef.current = promotion;

  useEffect(() => {
    if (!token) return;
    const live = { cancelled: false };
    getMcpServers()
      .then((all) => {
        if (!live.cancelled) setServers(all);
      })
      .catch(() => {
        // Keep whatever was loaded: a failed refresh is not "no servers".
        if (!live.cancelled) setServers((s) => s ?? []);
      });
    return () => {
      live.cancelled = true;
    };
  }, [token, serversTick]);

  useEffect(() => {
    const before = prev.current;
    prev.current = { id: conversationId, target };
    if (before.id === conversationId && before.target === target) return;

    if (target === 'pending') {
      // A new conversation keeps its choices across null → `c<ts>`; leaving a
      // real one for a new one starts from nothing.
      if (before.target === 'patch') setOverrides(EMPTY);
      setConvLoaded(true);
      setIsOwner(true);
      return;
    }
    if (!token || conversationId === null) return;

    // The conversation that just came into being carries the choices made for
    // it; show them while its row is fetched, rather than flashing defaults.
    const carried = carriesChoices(before.id, conversationId, promotionRef.current)
      ? overridesToSend(overridesRef.current)
      : undefined;
    if (!carried) {
      setOverrides(null);
      setConvLoaded(false);
    }
    const live = { cancelled: false };
    // Read through a call: the checker narrows a property to `false` after the
    // first check and cannot see that the await in between changes it.
    const cancelled = () => live.cancelled;
    getConversation(conversationId)
      .then(async (conv) => {
        if (cancelled()) return;
        setIsOwner(conv.role === undefined || conv.role === 'owner');
        if (carried && !sameOverrides(conv.mcpOverrides, carried)) {
          const updated = await updateConversation(conversationId, { mcp_overrides: carried });
          if (!cancelled()) setOverrides(updated.mcpOverrides ?? EMPTY);
        } else {
          setOverrides(conv.mcpOverrides ?? EMPTY);
        }
        setConvLoaded(true);
      })
      .catch(() => {
        if (cancelled()) return;
        // Could not ask: leave the switches disabled rather than guess.
        setConvLoaded(!!carried);
      });
    return () => {
      live.cancelled = true;
    };
  }, [token, conversationId, target]);

  const toggle = useCallback(
    (serverId: string, on: boolean) => {
      const before = overridesRef.current;
      const next = applyToggle(before, serverId, on);
      setOverrides(next);
      if (toggleTarget(conversationId) === 'pending' || conversationId === null) return;
      updateConversation(conversationId, { mcp_overrides: next }).catch(() => {
        // Only undo this toggle if nothing has changed since.
        setOverrides((cur) => (cur === next ? before : cur));
        showToast('Could not update MCP settings for this conversation');
      });
    },
    [conversationId, showToast],
  );

  const refresh = useCallback(() => {
    setServersTick((n) => n + 1);
  }, []);

  const rows = useMemo(() => (servers ? switchRows(servers, kind, overrides) : []), [servers, kind, overrides]);

  const lockedReason =
    kind === 'routine' && conversationId === null
      ? "Open one of this routine's chats to choose its servers."
      : !isOwner
        ? "Only this conversation's owner can change its servers."
        : null;
  const loading = servers === null || !convLoaded;

  return {
    rows,
    loading,
    lockedReason,
    canToggle: !loading && lockedReason === null && reachable,
    toggle,
    refresh,
    pendingOverrides: target === 'pending' ? overridesToSend(overrides) : undefined,
  };
}
