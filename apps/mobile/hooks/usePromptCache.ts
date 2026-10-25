import { useCallback, useEffect, useState } from 'react';
import { getPromptCache, type PromptCacheView } from '@loxaic/api-client';
import { useServerReachable } from '@/lib/connection';
import { promptCacheBanner, type PromptCacheBanner } from '@/lib/promptCache';

/** How often an open conversation asks again: a reload someone else caused
 * (an admin's save, a restart) shows without anything here changing. */
const POLL_MS = 60_000;

/**
 * The open conversation's prompt-cache banner (lib/promptCache.ts): asked of
 * the server when the conversation or model changes, when a reply ends, when
 * `modelKey` changes (the model list saw it reload) and once a minute. Offline
 * it says nothing — "could not ask" is not "gone".
 */
export function usePromptCache(input: {
  /** A conversation the server knows, or null. */
  conversationId: string | null;
  model: string | undefined;
  modelName: string;
  /** A reply is running: it is already paying for whatever there is. */
  running: boolean;
  /** Changes when the model list says the model loaded or reloaded. */
  modelKey: string;
}): { banner: PromptCacheBanner | null; dismiss: (key: string) => void } {
  const { conversationId, model, running, modelKey } = input;
  const reachable = useServerReachable();
  const [answer, setAnswer] = useState<{ conversationId: string; model: string; view: PromptCacheView } | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!conversationId || !model || running || !reachable) return;
    let alive = true;
    const ask = () => {
      getPromptCache(conversationId, model)
        .then((view) => { if (alive) setAnswer({ conversationId, model, view }); })
        .catch(() => undefined);
    };
    ask();
    const id = setInterval(ask, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [conversationId, model, running, reachable, modelKey]);

  const dismiss = useCallback((key: string) => {
    setDismissed((prev) => new Set(prev).add(key));
  }, []);

  const view = answer?.conversationId === conversationId && answer.model === model ? answer.view : null;
  const banner =
    conversationId && reachable
      ? promptCacheBanner({ conversationId, view, modelName: input.modelName, running, dismissed })
      : null;
  return { banner, dismiss };
}
