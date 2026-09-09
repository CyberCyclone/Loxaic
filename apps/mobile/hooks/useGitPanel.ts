import { useCallback, useEffect, useState } from 'react';
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
 */
export function useGitPanel(conversationId: string | null, refreshKey?: unknown) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      setStatus(await getGitStatus(conversationId));
    } catch {
      // Silent: this is a supplementary panel, and a scratch workspace (400)
      // or an optimistic pre-server conversation id (404) both just mean
      // "nothing to show here" rather than an error worth surfacing.
      setStatus(null);
    } finally {
      setLoading(false);
    }
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
