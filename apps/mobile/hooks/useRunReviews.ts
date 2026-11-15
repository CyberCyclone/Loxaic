import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunReview } from '@loxaic/api-client';
import type { RunReviewsUi } from '@/components/chat/RunReviewContext';
import { useRunReviewDetail } from './useRunReviewDetail';
import type { RunReviewController } from './useRunReviewState';

const NONE: readonly RunReview[] = [];

/**
 * One thread's progress reviews, as its screen uses them: the cards its
 * transcript shows, the context they open through, and the open panel.
 *
 * `controller` is the session hook's review state, which holds every
 * conversation's; this narrows it to the thread on screen, and to the
 * sub-agent whose panel is open over it (`childConvId`), whose stored reviews
 * are asked for when that panel opens.
 */
export function useRunReviews(controller: RunReviewController, convId: string | null, childConvId: string | null = null) {
  const { byConv, loadFor } = controller;
  const list = (convId ? byConv[convId] : undefined) ?? NONE;
  const childList = (childConvId ? byConv[childConvId] : undefined) ?? NONE;
  const [openId, setOpenId] = useState<string | null>(null);

  // The panel belongs to the thread it was opened from.
  useEffect(() => {
    setOpenId(null);
  }, [convId]);

  useEffect(() => {
    if (childConvId) loadFor(childConvId);
  }, [childConvId, loadFor]);

  // From the live list, not a copy taken when it opened: a review opened
  // while under way shows its verdict when it ends. One removed by a rewind
  // closes its panel.
  const open = useMemo(() => (openId ? (list.find((r) => r.id === openId) ?? null) : null), [list, openId]);
  const { state: detail, retry } = useRunReviewDetail(convId, open);

  const ui = useMemo<RunReviewsUi>(() => ({ open: (review) => { setOpenId(review.id); } }), []);
  const close = useCallback(() => { setOpenId(null); }, []);

  return {
    /** The thread's cards, in thread order. */
    list,
    /** The open sub-agent's cards. */
    childList,
    /** Provided to the transcript through `RunReviewContext`. */
    ui,
    /** Whether the review panel is on screen: no other sheet may open over it. */
    sheetOpen: open !== null,
    panel: { review: open, detail, retry, close },
  };
}
