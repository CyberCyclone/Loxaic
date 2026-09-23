import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelLocalModel,
  deleteLocalModel,
  downloadLocalModel,
  getLocalModels,
  pauseLocalModel,
  restartLocalRuntime,
  resumeLocalModel,
  updateLocalModel,
  updateLocalModelsSettings,
  type LoadSettings,
  type LocalModel,
  type LocalModelsView,
} from '@loxaic/api-client';
import { pollIntervalMs } from '@/lib/localModels';
import { useToastHelper } from './useToastHelper';

/**
 * The Local models screen's one copy of the server's state.
 *
 * Polled — there is no push channel for this, and the answer is small — every
 * second while the runtime is installing or anything is downloading, and every
 * fifteen seconds otherwise. Every action answers with fresh state or is
 * followed by a refresh, so the screen never shows its own guess for long.
 *
 * `token` is the admin's or null, as for `useProviders`: a non-admin's screen
 * never calls routes that would 403 them.
 */
export function useLocalModels(token: string | null) {
  const [view, setView] = useState<LocalModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToastHelper();
  // Only the newest answer may land: a slow poll that started before an
  // action must not overwrite what the action just returned.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    const mine = ++seq.current;
    try {
      const next = await getLocalModels();
      if (mine !== seq.current) return;
      setView(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err.message : 'Could not load local models');
    }
  }, [token]);

  const accept = useCallback((next: LocalModelsView) => {
    seq.current++;
    setView(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const interval = pollIntervalMs(view);
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => { void refresh(); }, interval);
    return () => { clearInterval(timer); };
  }, [token, interval, refresh]);

  /** Run an action; on failure, say why in a toast and hand the error back. */
  const act = useCallback(
    async <T,>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
      try {
        const result = await fn();
        if (done) showToast(done);
        return result;
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Something went wrong', 6000);
        return null;
      } finally {
        void refresh();
      }
    },
    [refresh, showToast],
  );

  const restart = useCallback(async () => {
    const next = await act(() => restartLocalRuntime());
    if (next) accept(next);
  }, [act, accept]);

  const updateSettings = useCallback(
    async (patch: Parameters<typeof updateLocalModelsSettings>[0]) => {
      const next = await act(() => updateLocalModelsSettings(patch));
      if (next) accept(next);
      return next !== null;
    },
    [act, accept],
  );

  const download = useCallback(
    (input: Parameters<typeof downloadLocalModel>[0]) => act(() => downloadLocalModel(input), 'Download started'),
    [act],
  );

  const pause = useCallback((id: string) => act(() => pauseLocalModel(id)), [act]);
  const resume = useCallback((id: string) => act(() => resumeLocalModel(id)), [act]);
  const cancel = useCallback((id: string) => act(() => cancelLocalModel(id), 'Download cancelled'), [act]);
  const remove = useCallback((id: string) => act(() => deleteLocalModel(id), 'Model deleted'), [act]);

  const update = useCallback(
    async (id: string, patch: { enabled?: boolean; displayName?: string; loadSettings?: LoadSettings }): Promise<LocalModel | null> => {
      // Optimistic for the switch, which should not lag a poll behind the tap.
      if (patch.enabled !== undefined) {
        setView((v) => (v ? { ...v, models: v.models.map((m) => (m.id === id ? { ...m, enabled: patch.enabled ?? m.enabled } : m)) } : v));
      }
      return act(() => updateLocalModel(id, patch));
    },
    [act],
  );

  return { view, error, refresh, restart, updateSettings, download, pause, resume, cancel, remove, update };
}
