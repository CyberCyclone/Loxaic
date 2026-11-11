import { useCallback, useMemo, useRef, useState } from 'react';
import { getRunReviews, type RunReview, type StreamEventKind, type StreamSnapshot, type StreamStatus } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';
import { reviewsAfterEnd, reviewsAfterEvent, reviewsAfterSnapshot, withListedReviews } from '@/lib/progressReview';

type ByConv = Partial<Record<string, readonly RunReview[]>>;

/**
 * Every conversation's progress-review cards, for a session hook: a thread's
 * and a sub-agent's alike, keyed by conversation id (a child's stream arrives
 * on the same socket under its own).
 *
 * Two feeds, merged by review id (lib/progressReview.ts): the stored listing,
 * asked for when a thread or a sub-agent's panel is opened and again after a
 * rewind, and the run's own stream, which carries each review as it starts
 * and ends.
 *
 * Every function returned is stable: the session hooks call them from inside
 * the effect that owns the socket.
 */
export function useRunReviewState() {
  const [byConv, setByConv] = useState<ByConv>({});
  // The newest request per conversation: an older answer landing late (a
  // listing asked before a rewind) must not put removed cards back.
  const askRef = useRef<Partial<Record<string, number>>>({});
  // The reviews the stream has told of since that request went out, which
  // its answer may be too old to hold.
  const heardRef = useRef<Partial<Record<string, Set<string>>>>({});

  const update = useCallback((convId: string, updater: (list: readonly RunReview[]) => readonly RunReview[]) => {
    setByConv((prev) => {
      const have = prev[convId] ?? NONE;
      const next = updater(have);
      return next === have ? prev : { ...prev, [convId]: next };
    });
  }, []);

  /** Asks for a conversation's stored reviews. A failure leaves what is held:
   * the stream still fills in the run on screen, and the next open asks again. */
  const loadFor = useCallback(
    (convId: string) => {
      if (!isServerConvId(convId)) return;
      const ask = (askRef.current[convId] ?? 0) + 1;
      askRef.current[convId] = ask;
      const heard = new Set<string>();
      heardRef.current[convId] = heard;
      getRunReviews(convId)
        .then((listed) => {
          if (askRef.current[convId] !== ask) return;
          update(convId, (list) => withListedReviews(list, listed, heard));
        })
        .catch(() => undefined);
    },
    [update],
  );

  const onSync = useCallback(
    (convId: string, streamId: string, snapshot: StreamSnapshot, status: StreamStatus) => {
      for (const review of snapshot.reviews ?? []) heardRef.current[convId]?.add(review.id);
      update(convId, (list) => reviewsAfterSnapshot(list, streamId, snapshot, status));
    },
    [update],
  );

  const onEvent = useCallback(
    (convId: string, event: StreamEventKind) => {
      if (event.kind !== 'run.review.start' && event.kind !== 'run.review.end') return;
      if (event.review) heardRef.current[convId]?.add(event.review.id);
      update(convId, (list) => reviewsAfterEvent(list, event));
    },
    [update],
  );

  const onEnd = useCallback(
    (convId: string, streamId: string) => {
      update(convId, (list) => reviewsAfterEnd(list, streamId));
    },
    [update],
  );

  return useMemo(() => ({ byConv, loadFor, onSync, onEvent, onEnd }), [byConv, loadFor, onSync, onEvent, onEnd]);
}

const NONE: readonly RunReview[] = [];

export type RunReviewController = ReturnType<typeof useRunReviewState>;
