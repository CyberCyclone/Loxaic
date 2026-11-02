import { useCallback, useEffect, useState } from 'react';
import { getSandboxes, type SandboxRow } from '@loxaic/api-client';
import type { SandboxChange } from '@loxaic/types';
import { pendingChangesOf } from '@/lib/sandboxChanges';

/**
 * The conversation's workspace as the Inspector reports it: whether one exists,
 * whether it is running or paused, and when it would be deleted.
 *
 * Fetched rather than derived from the stream, because a workspace outlives
 * every run in it — the interesting states (paused since yesterday, deleted
 * last week) are exactly the ones no live event will ever announce.
 */
export function useWorkspaceStatus(conversationId: string | null, refreshKey?: unknown) {
  const [sandbox, setSandbox] = useState<SandboxRow | null>(null);
  const [pendingChanges, setPendingChanges] = useState<SandboxChange[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setSandbox(null);
      setPendingChanges([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await getSandboxes(conversationId);
      // Newest first from the server. A conversation can accumulate rows —
      // one per provider kind after a mode switch, plus tombstones — and the
      // one worth reporting is the newest that still exists.
      setSandbox(rows.find((row) => row.status !== 'destroyed') ?? null);
      setPendingChanges(pendingChangesOf(rows));
    } catch {
      // Silent: this is a supplementary panel, and an optimistic conversation
      // id that the server has never seen 404s here by design.
      setSandbox(null);
      setPendingChanges([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return { sandbox, pendingChanges, loading, refresh };
}
