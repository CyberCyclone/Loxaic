import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isOpen, planStatus, plansIn, type PlanStatus, type ProposedPlan } from '@/lib/plan';
import type { Message } from '@/lib/types';

/**
 * Which plan the panel shows, when it opens by itself, and what the bar and
 * the cards say (#199).
 *
 * The panel opens by itself for the newest plan while it is **pending** —
 * whether the run that made it just ended or the thread was just opened — and
 * only for someone who can decide on it, with nothing running. Once per plan
 * per session: closing it, or sending a suggestion, is an answer to "show me",
 * and from then on the bar above the toolbar carries it instead. Viewers get
 * the bar, never a sheet over the thread they came to read.
 */
export function usePlanReview(input: {
  convId: string | null;
  msgs: readonly Message[];
  busy: boolean;
  canDecide: boolean;
}) {
  const { convId, msgs, busy, canDecide } = input;
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  // Call ids this session has already shown or had dismissed. A ref: the
  // decision to auto-open is made in an effect, and must not wait on (or
  // re-trigger) a render.
  const seen = useRef(new Set<string>());

  const plans = useMemo(() => plansIn(msgs), [msgs]);
  const latestFull = plans.at(-1);
  const latestId = latestFull?.callId ?? null;
  const latestStatus: PlanStatus | null = latestId ? planStatus(msgs, latestId) : null;

  // Every plan's status as one string, so a streamed token — a new `msgs`
  // array — does not hand every plan card a new context value.
  // JSON rather than a joined string: a call id is the model's, and some
  // backends put ":" in them ("functions.propose_plan:0").
  const signature = JSON.stringify(plans.map((p) => [p.callId, planStatus(msgs, p.callId)]));
  const statuses = useMemo(() => new Map(JSON.parse(signature) as [string, PlanStatus | null][]), [signature]);

  // Another conversation's plan is never the one on screen.
  useEffect(() => {
    setOpenCallId(null);
  }, [convId]);

  useEffect(() => {
    if (!latestId || latestStatus !== 'pending' || busy || !canDecide || seen.current.has(latestId)) return;
    seen.current.add(latestId);
    setOpenCallId(latestId);
  }, [latestId, latestStatus, busy, canDecide]);

  const openPlan = useCallback((callId: string) => {
    seen.current.add(callId);
    setOpenCallId(callId);
  }, []);
  const close = useCallback(() => { setOpenCallId(null); }, []);
  const statusOf = useCallback((callId: string) => statuses.get(callId) ?? null, [statuses]);

  const found = openCallId ? plans.find((p) => p.callId === openCallId) : undefined;
  const open: ProposedPlan | null = found ? { callId: found.callId, text: found.text, title: found.title } : null;
  const latest: ProposedPlan | null = latestFull
    ? { callId: latestFull.callId, text: latestFull.text, title: latestFull.title }
    : null;

  return {
    /** The newest plan — what the menu item and the bar open. */
    latest,
    latestStatus,
    /** Whether the bar shows: the newest plan is undecided and its panel is closed. */
    showBar: latest !== null && isOpen(latestStatus) && openCallId === null,
    /** The plan the panel shows, or null when it is closed. */
    open,
    openStatus: open ? (statuses.get(open.callId) ?? null) : null,
    openPlan,
    close,
    statusOf,
  };
}
