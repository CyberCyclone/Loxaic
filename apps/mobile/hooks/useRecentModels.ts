import { useCallback, useEffect, useState } from 'react';
import { getPrefs } from '@loxaic/api-client';

/**
 * The models this user last sent with, newest first — what the picker shows
 * under "Recently used".
 *
 * Read-only from the client's side: the server records a model when it is
 * actually used, so nothing here writes. `bump` is an optimistic local
 * reorder so that the picker is already right the moment it is reopened,
 * rather than a turn behind; the next fetch replaces it with the server's own
 * answer.
 */
export function useRecentModels(token: string | null) {
  const [recentModels, setRecentModels] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const prefs = await getPrefs();
      // Absent means this server does not track it — not that nothing has been
      // used. Either way there is nothing to show, but the distinction is why
      // this never writes a default back.
      setRecentModels(prefs.recentModels ?? []);
    } catch {
      // A failed read costs an unsorted picker, never an error in front of
      // someone trying to pick a model.
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Move a model to the front locally, mirroring what the server just did. */
  const bump = useCallback((ref: string) => {
    if (!ref || ref === 'default') return;
    setRecentModels((prev) => [ref, ...prev.filter((r) => r !== ref)].slice(0, 8));
  }, []);

  return { recentModels, refreshRecentModels: refresh, bumpRecentModel: bump };
}
