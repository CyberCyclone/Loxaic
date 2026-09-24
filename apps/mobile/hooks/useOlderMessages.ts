import { useCallback, useRef, useState } from 'react';
import { getMessages, type MessagePage } from '@loxaic/api-client';
import { pagingFrom, type HistoryPaging } from '@/lib/historyPages';
import { reconstructMessages } from '@/lib/streamMessages';
import type { Message } from '@/lib/types';

/**
 * Scroll-back for a thread's history (#213), shared by the Chat and Agent
 * session hooks so the two surfaces page identically.
 *
 * The session hook records each conversation's first page with `record`; the
 * message list calls `loadOlder` when it reaches the oldest loaded message.
 * `apply` is the hook's own way of putting the older messages in front of a
 * conversation's thread — the one thing the two hooks store differently.
 *
 * In-flight requests are tracked in a ref, not state: the list's end-reached
 * callback can fire several times before a state update lands, and each would
 * otherwise fetch the same page.
 */
export function useOlderMessages(apply: (conversationId: string, older: Message[]) => void) {
  const [paging, setPaging] = useState<Record<string, HistoryPaging>>({});
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const inFlight = useRef(new Set<string>());

  const record = useCallback((conversationId: string, page: Pick<MessagePage, 'hasMore' | 'before'>) => {
    setPaging((prev) => ({ ...prev, [conversationId]: pagingFrom(page) }));
  }, []);

  const loadOlder = useCallback(
    (conversationId: string) => {
      const before = (pagingRef.current[conversationId] as HistoryPaging | undefined)?.before;
      if (!before || inFlight.current.has(conversationId)) return;
      inFlight.current.add(conversationId);
      setPaging((prev) => ({ ...prev, [conversationId]: { before, loading: true } }));
      getMessages(conversationId, { before })
        .then((page) => {
          apply(conversationId, reconstructMessages(page.messages));
          record(conversationId, page);
        })
        .catch(() => {
          // Keep the cursor: a failed read is worth retrying, and scrolling
          // back to the top again is how a person retries it.
          setPaging((prev) => ({ ...prev, [conversationId]: { before, loading: false } }));
        })
        .finally(() => {
          inFlight.current.delete(conversationId);
        });
    },
    [apply, record],
  );

  /** Whether history older than the loaded page exists — read from a ref, so
   * a socket handler can ask without re-subscribing on every page. */
  const hasOlder = useCallback(
    (conversationId: string) => Boolean((pagingRef.current[conversationId] as HistoryPaging | undefined)?.before),
    [],
  );

  return { paging, record, loadOlder, hasOlder };
}
