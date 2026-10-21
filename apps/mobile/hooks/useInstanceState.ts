import { useCallback, useEffect, useState } from 'react';
import { electronBridge, type InstanceState } from '@/lib/endpoint';

/**
 * The desktop main process's instance state, from the renderer's side —
 * mode, host settings, listen port. Same shape as useLocalExecutor: fetch
 * once, then follow onStackState so a mode/settings change elsewhere (or a
 * restart this same screen triggered) is reflected without a manual refresh.
 * Null off Electron, or when the fetch failed; undefined until the first
 * fetch settles — so a screen can wait for the state without waiting forever
 * when it never comes.
 */
export function useInstanceState(): InstanceState | null | undefined {
  const bridge = electronBridge();
  const [state, setState] = useState<InstanceState | null | undefined>(bridge ? undefined : null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setState(await bridge.instance.getState());
    } catch {
      setState(null);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    return bridge.instance.onStackState(setState);
  }, [bridge, refresh]);

  return state;
}
