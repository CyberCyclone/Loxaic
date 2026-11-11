import { useCallback, useEffect, useState } from 'react';
import { getRunReview, type RunReview, type RunReviewDetail } from '@loxaic/api-client';
import { useServerReachable } from '@/lib/connection';

/** The full record behind an open review card: `loading`, the record, or
 * `failed` — "could not ask", which is not "there is nothing". */
export type ReviewDetailState =
  | { status: 'idle' | 'loading' | 'failed'; detail: null }
  | { status: 'loaded'; detail: RunReviewDetail };

const IDLE: ReviewDetailState = { status: 'idle', detail: null };

/**
 * Loads the record of the review whose card is open: what it cost and the
 * digest the reviewer read, which no card carries.
 *
 * Asked for once the review has ended (its record is written just before its
 * `run.review.end`), again when the server comes back after a failure, and on
 * `retry`. A review still under way has no record yet.
 */
export function useRunReviewDetail(conversationId: string | null, review: RunReview | null) {
  const reachable = useServerReachable();
  const [state, setState] = useState<ReviewDetailState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const id = review?.id ?? null;
  const ended = review ? review.ended_at !== undefined : false;

  useEffect(() => {
    if (!conversationId || !id || !ended) {
      setState(IDLE);
      return;
    }
    if (!reachable) {
      // Nothing to ask; what was loaded for this same review stays readable.
      setState((prev) => (prev.status === 'loaded' && prev.detail.id === id ? prev : { status: 'failed', detail: null }));
      return;
    }
    let current = true;
    setState((prev) => (prev.status === 'loaded' && prev.detail.id === id ? prev : { status: 'loading', detail: null }));
    getRunReview(conversationId, id)
      .then((detail) => {
        if (current) setState({ status: 'loaded', detail });
      })
      .catch(() => {
        if (current) setState({ status: 'failed', detail: null });
      });
    return () => {
      current = false;
    };
  }, [conversationId, id, ended, reachable, attempt]);

  const retry = useCallback(() => { setAttempt((n) => n + 1); }, []);
  return { state, retry };
}
