import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBrowserSettings,
  installBrowser,
  updateBrowserSettings,
  type BrowserSettings,
  type BrowserSettingsPatch,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';
import { browserPollMs } from '@/lib/browserSettings';

/** Admin-only: web_fetch's browser fallback (#281). Polls while Chromium is
 * downloading so the progress moves; `token` gates the fetch as in
 * useSandboxSettings, since these routes refuse anyone but an admin. */
export function useBrowserSettings(token: string | null) {
  const [settings, setSettings] = useState<BrowserSettings | null>(null);
  const { showToast } = useToastHelper();
  // A poll that started before a write must not put the old state back.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    const mine = generation.current;
    try {
      const next = await getBrowserSettings();
      if (mine === generation.current) setSettings(next);
    } catch {
      // A missed poll is retried by the next one; the screen keeps what it has.
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const poll = settings ? browserPollMs(settings) : null;
  useEffect(() => {
    if (poll === null) return;
    const timer = setInterval(() => { void refresh(); }, poll);
    return () => { clearInterval(timer); };
  }, [poll, refresh]);

  const write = useCallback(
    async (run: () => Promise<BrowserSettings>, fallback: string) => {
      generation.current++;
      try {
        setSettings(await run());
      } catch (err) {
        showToast(err instanceof Error ? err.message : fallback, 4000);
        await refresh();
      }
    },
    [refresh, showToast],
  );

  const update = useCallback(
    (patch: BrowserSettingsPatch) => write(() => updateBrowserSettings(patch), 'Failed to update web browsing'),
    [write],
  );
  const install = useCallback(() => write(() => installBrowser(), 'Failed to start the browser download'), [write]);

  return { settings, update, install, refresh };
}
