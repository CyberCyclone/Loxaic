import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrefs, updatePrefs, type UserPrefs } from '@loxaic/api-client';
import { useToastHelper } from '@/hooks/useToastHelper';
import { revertPatch } from '@/lib/prefsRollback';
import { reloadPrefsNow } from '@/lib/prefsReload';
import { useServerReachable } from '@/lib/connection';

/**
 * `/v1/prefs`, loaded once for a screen of settings (and again when the server
 * comes back, if that load failed), with optimistic saves.
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

  const liveRef = useRef(true);
  useEffect(() => {
    // Set again on a remount (React's strict mode runs effects twice).
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);
  // Only the latest load is applied: the first, sent while the server was
  // away, can fail after the one sent on its return has succeeded.
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const current = () => liveRef.current && seq === loadSeqRef.current;
    try {
      const loaded = await getPrefs();
      if (current()) setPrefs(loaded);
    } catch {
      if (current()) setPrefs(null);
    } finally {
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const reachable = useServerReachable();
  const wasReachableRef = useRef(reachable);
  useEffect(() => {
    const now = reloadPrefsNow({ wasReachable: wasReachableRef.current, reachable, loaded: prefsRef.current !== null });
    wasReachableRef.current = reachable;
    if (now) {
      setLoading(true);
      void load();
    }
  }, [reachable, load]);

  /** `onSettled` is told whether the server stored it, after the screen has
   * been put back on a failure. */
  const save = useCallback(
    (patch: Partial<UserPrefs>, onSettled?: (ok: boolean) => void) => {
      const previous = prefsRef.current;
      if (!previous) return;
      // Optimistic: a chip must not lag the tap. Rolled back on failure.
      setPrefs({ ...previous, ...patch });
      setInFlight((n) => n + 1);
      void (async () => {
        try {
          const saved = await updatePrefs(patch);
          setPrefs((current) => (current ? { ...current, ...saved } : saved));
          onSettled?.(true);
        } catch (err) {
          // Put back only the fields *this* save touched. Restoring the whole
          // snapshot would also undo a later save that succeeded, leaving the
          // screen disagreeing with the server until a reload.
          setPrefs((current) => revertPatch(current, previous, patch));
          onSettled?.(false);
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
