import { useCallback, useEffect, useRef, useState } from 'react';
import {
  commitGit,
  getGitStatus,
  openPullRequest,
  pushGit,
  GitActionError,
  type GitStatus,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';

/**
 * Git status and actions for an agent conversation's GitHub workspace.
 *
 * Only meaningful for a `github` workspace — the Inspector mounts this hook
 * only then. Refetches on `refreshKey` changing (the caller passes `runState`,
 * so a turn ending is what would have changed anything: a commit/push/PR
 * happens through this hook's own actions, and the agent's own tool calls are
 * the only other thing that touches the checkout).
 *
 * Every response is checked against the conversation that is current when
 * it lands, and `status` is dropped the moment the conversation changes.
 * Without both, switching between two github conversations kept the
 * previous one's branch, change count and PR link on screen for the length
 * of the fetch — while Commit/Push/Open PR already acted on the new one, and
 * Push was enabled on the strength of the other conversation's commits.
 */
export function useGitPanel(conversationId: string | null, refreshKey?: unknown) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToastHelper();
  const currentRef = useRef(conversationId);
  currentRef.current = conversationId;

  const refresh = useCallback(async () => {
    const id = conversationId;
    if (!id) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      const next = await getGitStatus(id);
      if (currentRef.current === id) setStatus(next);
    } catch {
      // Silent: this is a supplementary panel, and a scratch workspace (400)
      // or an optimistic pre-server conversation id (404) both just mean
      // "nothing to show here" rather than an error worth surfacing.
      if (currentRef.current === id) setStatus(null);
    } finally {
      if (currentRef.current === id) setLoading(false);
    }
  }, [conversationId]);

  // Nothing from the previous conversation survives the switch, not even
  // for the duration of the first fetch.
  useEffect(() => {
    setStatus(null);
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await action();
        await refresh();
        return result;
      } catch (err) {
        showToast(err instanceof GitActionError ? err.message : 'Git action failed', 5000);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh, showToast],
  );

  const commit = useCallback(
    (message: string) => {
      if (!conversationId) return Promise.resolve(null);
      return run(() => commitGit(conversationId, message));
    },
    [conversationId, run],
  );
  const push = useCallback(() => {
    if (!conversationId) return Promise.resolve(null);
    return run(() => pushGit(conversationId));
  }, [conversationId, run]);
  const openPr = useCallback(
    (title: string, body?: string) => {
      if (!conversationId) return Promise.resolve(null);
      return run(() => openPullRequest(conversationId, title, body));
    },
    [conversationId, run],
  );

  return { status, loading, busy, refresh, commit, push, openPr };
}
