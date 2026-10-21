import { useCallback, useEffect, useState } from 'react';
import {
  getInferenceSettings,
  isUnreachableError,
  updateInferenceSettings,
  type InferenceSettings,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';
import { describeRequestError, useServerReachable } from '@/lib/connection';

/** Admin-only run-concurrency setting, mirroring useSandboxSettings. `token`
 * gates the fetch since the route 403s for anyone else. */
export function useInferenceSettings(token: string | null) {
  const [settings, setSettings] = useState<InferenceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  /** Why the last load failed, or null. Settings already loaded are kept. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const { showToast } = useToastHelper();
  const reachable = useServerReachable();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setSettings(await getInferenceSettings());
      setLoadError(null);
    } catch (err) {
      // describeRequestError's "nothing was changed" is for a write; this only read.
      setLoadError(
        isUnreachableError(err)
          ? "Couldn't load the server settings: can't reach your server."
          : describeRequestError(err, "Couldn't load the server settings"),
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A load that failed is asked again once the server is back.
  useEffect(() => {
    if (reachable && loadError !== null) void refresh();
  }, [reachable, loadError, refresh]);

  const update = useCallback(
    async (patch: Parameters<typeof updateInferenceSettings>[0]) => {
      const previous = settings;
      // No optimistic merge for the resolved number: it is computed by the
      // server (it may probe the backend), so guessing it here would flash a
      // value that is about to be corrected.
      try {
        setSettings(await updateInferenceSettings(patch));
      } catch (err) {
        setSettings(previous);
        showToast(err instanceof Error ? err.message : 'Failed to update the inference settings', 4000);
      }
    },
    [settings, showToast],
  );

  return { settings, loading, loadError, refresh, update };
}
