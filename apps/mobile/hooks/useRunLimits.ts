import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConversation, updateConversation } from '@loxaic/api-client';
import { LIMITS_ON, type RunLimits } from '@loxaic/types';
import { useServerReachable } from '@/lib/connection';
import { carriesChoices, toggleTarget, type Promotion } from '@/lib/mcpSwitches';
import { limitsOf, limitsToSend, runLimitRows, sameLimits, type RunLimitKey, type RunLimitRow, type RunLimitsLink } from '@/lib/runLimits';
import { useToastHelper } from './useToastHelper';

export interface RunLimitSwitches {
  rows: RunLimitRow[];
  /** Why the switches are locked, when it is who is looking. */
  lockedReason: string | null;
  canToggle: boolean;
  toggle: (key: RunLimitKey, on: boolean) => void;
}

/**
 * The conversation on screen's run limits, shared by Chat and Agent. They work
 * as `useMcpSwitches`' switches do: held here and carried by the first send
 * until the conversation exists, then PATCHed, which reaches a run in progress.
 * `link` is what the session reads at send time and reports changes through.
 */
export function useRunLimits(
  token: string | null,
  conversationId: string | null,
  promotion: Promotion | null | undefined,
  link: { current: RunLimitsLink | null },
): RunLimitSwitches {
  const reachable = useServerReachable();
  const { showToast } = useToastHelper();
  const [limits, setLimits] = useState<RunLimits>(LIMITS_ON);
  const [loaded, setLoaded] = useState(true);
  const [isOwner, setIsOwner] = useState(true);
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const target = toggleTarget(conversationId);
  const prev = useRef<{ id: string | null | undefined; target: 'pending' | 'patch' }>({ id: undefined, target: 'pending' });
  const promotionRef = useRef(promotion);
  promotionRef.current = promotion;

  useEffect(() => {
    const before = prev.current;
    prev.current = { id: conversationId, target };
    if (before.id === conversationId && before.target === target) return;

    if (target === 'pending') {
      // A new conversation keeps its choices across null → `c<ts>`; leaving a
      // real one for a new one starts from nothing.
      if (before.target === 'patch') setLimits(LIMITS_ON);
      setLoaded(true);
      setIsOwner(true);
      return;
    }
    if (!token || conversationId === null) return;

    const carried = carriesChoices(before.id, conversationId, promotionRef.current) ? limitsRef.current : null;
    if (!carried) setLoaded(false);
    const live = { cancelled: false };
    // Read through a call: the checker narrows a property to `false` after the
    // first check and cannot see that the await in between changes it.
    const cancelled = () => live.cancelled;
    getConversation(conversationId)
      .then(async (conv) => {
        if (cancelled()) return;
        setIsOwner(conv.role === undefined || conv.role === 'owner');
        const stored = limitsOf(conv);
        // A switch flipped while the send was in flight, or a server that
        // ignored it on the send.
        if (carried && !sameLimits(stored, carried)) {
          const updated = await updateConversation(conversationId, {
            step_limit_off: carried.stepLimitOff,
            loop_check_off: carried.loopCheckOff,
          });
          if (!cancelled()) setLimits(limitsOf(updated));
        } else {
          setLimits(stored);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled()) return;
        // Could not ask: leave the switches disabled rather than guess.
        setLoaded(!!carried);
      });
    return () => {
      live.cancelled = true;
    };
  }, [token, conversationId, target]);

  const toggle = useCallback(
    (key: RunLimitKey, on: boolean) => {
      const before = limitsRef.current;
      const next = { ...before, [key]: !on };
      limitsRef.current = next;
      setLimits(next);
      if (toggleTarget(conversationId) === 'pending' || conversationId === null) return;
      updateConversation(conversationId, key === 'stepLimitOff' ? { step_limit_off: !on } : { loop_check_off: !on }).catch(() => {
        // Only undo this toggle if nothing has changed since.
        setLimits((cur) => (cur === next ? before : cur));
        showToast('Could not update this conversation');
      });
    },
    [conversationId, showToast],
  );

  link.current = {
    pending: target === 'pending' ? limitsToSend(limits) : undefined,
    onChange: (id, changed) => {
      if (id === conversationId) setLimits(changed);
    },
  };

  const rows = useMemo(() => runLimitRows(limits), [limits]);
  const lockedReason = isOwner ? null : "Only this conversation's owner can change these.";

  return { rows, lockedReason, canToggle: loaded && isOwner && reachable, toggle };
}
