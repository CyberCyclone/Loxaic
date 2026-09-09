import { useCallback, useEffect, useState } from 'react';
import { electronBridge, type InstanceState } from '@/lib/endpoint';

/**
 * The desktop main process's instance state, from the renderer's side —
 * mode, host settings, listen port. Same shape as useLocalExecutor: fetch
 * once, then follow onStackState so a mode/settings change elsewhere (or a
 * restart this same screen triggered) is reflected without a manual refresh.
 * Null off Electron and before the first fetch resolves.
 */
export function useInstanceState(): InstanceState | null {
  const bridge = electronBridge();
  const [state, setState] = useState<InstanceState | null>(null);

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
