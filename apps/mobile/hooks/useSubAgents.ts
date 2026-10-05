import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubAgentsUi } from '@/components/subagents/SubAgentContext';
import {
  firstChildApproval,
  listedSubAgents,
  runningCount,
  subAgentForCall,
  type SubAgentView,
} from '@/lib/subAgents';
import type { SubAgentController } from './useSubAgentState';

/** How long a sheet takes to leave. iOS will not present a second overlay
 * while the first is still being dismissed, so the panel opens after the list
 * has gone — the rule the plan panel's model picker follows. */
const SHEET_EXIT_MS = 300;

/**
 * One thread's sub-agents, as its screen uses them: the context its cards
 * read, the list behind the ⋮ item, the open panel, and the approval to show
 * when the thread's own run is not asking for one.
 *
 * `controller` is the session hook's sub-agent state, which holds every
 * thread's; this narrows it to the thread on screen.
 */
export function useSubAgents(controller: SubAgentController, parentConvId: string | null, canAct: boolean) {
  const { byParent, transcripts, openId, stopping, listFailed, loadFor, open, close, stop, answer } = controller;
  const list = parentConvId ? byParent[parentConvId] : undefined;
  const [listOpen, setListOpen] = useState(false);
  // True between the list closing and the panel it handed over to opening.
  const [handingOver, setHandingOver] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The panel and the list belong to the thread they were opened from.
  // Switching threads closes both; left open, the panel would show another
  // thread's sub-agent over this one.
  useEffect(() => {
    close();
    setListOpen(false);
    setHandingOver(false);
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    };
  }, [parentConvId, close]);

  const panelView: SubAgentView | null = useMemo(
    () => (openId ? (list?.find((s) => s.conversation_id === openId) ?? null) : null),
    [list, openId],
  );

  const isStopping = useCallback((childConvId: string) => stopping.has(childConvId), [stopping]);

  const ui = useMemo<SubAgentsUi>(
    () => ({
      forCall: (callId, messageId) => subAgentForCall(list, callId, messageId),
      open,
      stop: (childConvId) => { stop(childConvId); },
      isStopping,
      canAct,
    }),
    [canAct, isStopping, list, open, stop],
  );

  const openFromList = useCallback((childConvId: string) => {
    setListOpen(false);
    setHandingOver(true);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setHandingOver(false);
      open(childConvId);
    }, SHEET_EXIT_MS);
  }, [open]);

  const listUnavailable = parentConvId ? listFailed.has(parentConvId) : false;
  // Opening the list is a person asking, so a listing that could not be
  // fetched is asked for again rather than left for the next reconnect.
  const openList = useCallback(() => {
    if (parentConvId) loadFor(parentConvId);
    setListOpen(true);
  }, [loadFor, parentConvId]);
  const retryList = useCallback(() => {
    if (parentConvId) loadFor(parentConvId);
  }, [loadFor, parentConvId]);

  // The child whose approval the thread's own screen shows. Not while its
  // panel is open, where the same question is already in the footer — and not
  // to a viewer, who cannot answer it.
  const approvalChild = useMemo(() => {
    if (!canAct) return null;
    const child = firstChildApproval(list);
    return child && child.conversation_id !== openId ? child : null;
  }, [canAct, list, openId]);

  return {
    /** Provided to the transcript through `SubAgentContext`. */
    ui,
    /** Running first, then finished. */
    listed: useMemo(() => listedSubAgents(list), [list]),
    running: runningCount(list),
    listOpen,
    /** The stored listing could not be asked for: the list is "unknown", not
     * "none". */
    listUnavailable,
    retryList,
    /**
     * One of this thread's sub-agent sheets is on screen, or about to be. No
     * other sheet may open over it: a second native overlay on top of the
     * first is what stranded sheets on iOS (AGENTS.md, "Plan review").
     */
    sheetOpen: listOpen || handingOver || openId !== null,
    openList,
    closeList: useCallback(() => { setListOpen(false); }, []),
    openFromList,
    isStopping,
    panel: {
      view: panelView,
      transcript: panelView ? (transcripts[panelView.conversation_id] ?? null) : null,
      stopping: panelView ? stopping.has(panelView.conversation_id) : false,
      stop: useCallback(() => { if (openId) stop(openId); }, [openId, stop]),
      allow: useCallback(() => { if (openId) answer(openId, true); }, [answer, openId]),
      allowAlways: useCallback(() => { if (openId) answer(openId, true, true); }, [answer, openId]),
      deny: useCallback(() => { if (openId) answer(openId, false); }, [answer, openId]),
      close,
    },
    /** A sub-agent waiting on this person, for the thread's own approval UI. */
    approvalChild,
    answer,
  };
}
