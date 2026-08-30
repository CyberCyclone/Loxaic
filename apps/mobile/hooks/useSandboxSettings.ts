import { useCallback, useEffect, useState } from 'react';
import {
  getSandboxSettings,
  updateSandboxSettings,
  type SandboxSettings,
  type SandboxSettingsPatch,
} from '@shannon/api-client';
import { useToastHelper } from './useToastHelper';

/** Admin-only sandbox settings (mode/engine/network) with optimistic writes,
 * mirroring useMcpServers.ts. `token` gates the initial fetch since these
 * routes 401/403 for anyone else — the settings screen renders a read-only
 * view instead of mounting this hook when the session isn't an admin's. */
export function useSandboxSettings(token: string | null) {
  const [settings, setSettings] = useState<SandboxSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setSettings(await getSandboxSettings());
      setError(null);
    } catch {
      setError('Failed to load sandbox settings');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: SandboxSettingsPatch) => {
      const previous = settings;
      // Optimistic per-field merge — a full server round trip (engine probe
      // included) can take a couple seconds and the picker should react
      // immediately; refresh() below reconciles once the real response lands.
      setSettings((s) => (s ? { ...s, ...patch } : s));
      try {
        const next = await updateSandboxSettings(patch);
        setSettings(next);
        return next;
      } catch (err) {
        setSettings(previous);
        const message = err instanceof Error ? err.message : 'Failed to update sandbox settings';
        showToast(message, 4000);
        throw err;
      }
    },
    [settings, showToast],
  );

  return { settings, loading, error, refresh, update };
}
