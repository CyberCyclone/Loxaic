import { useCallback, useEffect, useState } from 'react';
import {
  getInferenceSettings,
  updateInferenceSettings,
  type InferenceSettings,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';

/** Admin-only run-concurrency setting, mirroring useSandboxSettings. `token`
 * gates the fetch since the route 403s for anyone else. */
export function useInferenceSettings(token: string | null) {
  const [settings, setSettings] = useState<InferenceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setSettings(await getInferenceSettings());
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (maxConcurrentRuns: number | null) => {
      const previous = settings;
      // No optimistic merge for the resolved number: it is computed by the
      // server (it may probe the backend), so guessing it here would flash a
      // value that is about to be corrected.
      try {
        setSettings(await updateInferenceSettings({ maxConcurrentRuns }));
      } catch (err) {
        setSettings(previous);
        showToast(err instanceof Error ? err.message : 'Failed to update run concurrency', 4000);
      }
    },
    [settings, showToast],
  );

  return { settings, loading, refresh, update };
}
