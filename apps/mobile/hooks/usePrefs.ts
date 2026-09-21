import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrefs, updatePrefs, type UserPrefs } from '@loxaic/api-client';
import { useToastHelper } from '@/hooks/useToastHelper';
import { revertPatch } from '@/lib/prefsRollback';

/**
 * `/v1/prefs`, loaded once for a screen of settings, with optimistic saves.
 *
 * `prefs` is null while loading and when the load failed (offline, or a server
 * too old to answer) — the screen shows nothing rather than a value that might
 * not be the server's. Each field inside may still be absent on an older
 * server, which callers read as "this server has no such setting".
 */
export function usePrefs() {
  const { showToast } = useToastHelper();
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  // A count, not a flag: with two saves in flight, the first to settle must
  // not re-enable every control while the other is still out.
  const [inFlight, setInFlight] = useState(0);
  const prefsRef = useRef<UserPrefs | null>(null);
  prefsRef.current = prefs;

  useEffect(() => {
    const live = { current: true };
    void (async () => {
      try {
        const loaded = await getPrefs();
        if (live.current) setPrefs(loaded);
      } catch {
        if (live.current) setPrefs(null);
      } finally {
        if (live.current) setLoading(false);
      }
    })();
    return () => {
      live.current = false;
    };
  }, []);

  const save = useCallback(
    (patch: Partial<UserPrefs>) => {
      const previous = prefsRef.current;
      if (!previous) return;
      // Optimistic: a chip must not lag the tap. Rolled back on failure.
      setPrefs({ ...previous, ...patch });
      setInFlight((n) => n + 1);
      void (async () => {
        try {
          const saved = await updatePrefs(patch);
          setPrefs((current) => (current ? { ...current, ...saved } : saved));
        } catch (err) {
          // Put back only the fields *this* save touched. Restoring the whole
          // snapshot would also undo a later save that succeeded, leaving the
          // screen disagreeing with the server until a reload.
          setPrefs((current) => revertPatch(current, previous, patch));
          showToast(`Could not save: ${(err as Error).message}`, 5000);
        } finally {
          setInFlight((n) => n - 1);
        }
      })();
    },
    [showToast],
  );

  return { prefs, loading, busy: inFlight > 0, save };
}
