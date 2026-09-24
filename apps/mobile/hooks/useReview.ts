import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isOpen,
  planStatus,
  questionsStatus,
  reviewItemsIn,
  type PlanStatus,
  type QuestionsStatus,
  type ReviewItem,
} from '@/lib/plan';
import type { Message } from '@/lib/types';

export type ReviewStatus = PlanStatus | QuestionsStatus;

function statusOfItem(msgs: readonly Message[], item: ReviewItem): ReviewStatus | null {
  return item.kind === 'plan' ? planStatus(msgs, item.callId) : questionsStatus(msgs, item.callId);
}

/** Waiting on the user: a plan nobody has accepted or rejected, or questions
 * nobody has answered. What keeps the bar above the toolbar. */
export function isAwaiting(item: ReviewItem | null, status: ReviewStatus | null): boolean {
  if (!item) return false;
  return item.kind === 'plan' ? isOpen(status as PlanStatus | null) : status === 'pending';
}

/**
 * Which plan or question set the panel shows, when one opens by itself, and
 * what the bar and the cards say (#199).
 *
 * Planning mode ends every turn in one or the other, so the newest item is
 * what the user is being asked about. It opens by itself while it is
 * **pending** — whether the run that made it just ended or the thread was just
 * opened — and only for someone who can act on it, with nothing running. Once
 * per item per session: closing it, or answering, is an answer to "show me",
 * and from then on the bar carries it. Viewers get the bar, never a sheet over
 * the thread they came to read.
 */
export function useReview(input: {
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

  const items = useMemo(() => reviewItemsIn(msgs), [msgs]);
  const latest = items.at(-1) ?? null;

  // Every item's status as one string, so a streamed token — a new `msgs`
  // array — does not hand every card a new context value. JSON rather than a
  // joined string: a call id is the model's, and some backends put ":" in them
  // ("functions.propose_plan:0").
  const signature = JSON.stringify(items.map((i) => [i.callId, statusOfItem(msgs, i)]));
  const statuses = useMemo(() => new Map(JSON.parse(signature) as [string, ReviewStatus | null][]), [signature]);
  const latestStatus = latest ? (statuses.get(latest.callId) ?? null) : null;

  // Another conversation's item is never the one on screen.
  useEffect(() => {
    setOpenCallId(null);
  }, [convId]);

  const latestId = latest?.callId ?? null;
  useEffect(() => {
    if (!latestId || latestStatus !== 'pending' || busy || !canDecide || seen.current.has(latestId)) return;
    seen.current.add(latestId);
    setOpenCallId(latestId);
  }, [latestId, latestStatus, busy, canDecide]);

  const openItem = useCallback((callId: string) => {
    seen.current.add(callId);
    setOpenCallId(callId);
  }, []);
  const close = useCallback(() => { setOpenCallId(null); }, []);
  const statusOf = useCallback((callId: string) => statuses.get(callId) ?? null, [statuses]);

  const open = openCallId ? (items.find((i) => i.callId === openCallId) ?? null) : null;

  return {
    /** The newest plan or question set — what the menu item and the bar open. */
    latest,
    latestStatus,
    /** Whether the bar shows: the newest item waits on the user and no panel is open. */
    showBar: isAwaiting(latest, latestStatus) && openCallId === null,
    /** The item a panel shows, or null when both are closed. */
    open,
    openStatus: open ? (statuses.get(open.callId) ?? null) : null,
    openItem,
    close,
    statusOf,
  };
}
