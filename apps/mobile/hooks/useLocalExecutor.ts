import { useCallback, useEffect, useState } from 'react';
import { electronBridge, type ExecutorState } from '@/lib/endpoint';

/**
 * The desktop app's local executor, from the renderer's side.
 *
 * Two hooks, deliberately: the *sync* runs once at the root and hands the
 * session token to the main process (which spawns the executor with it),
 * and the *state* hook is for anything that wants to show or drive it — the
 * workspace chooser, mainly. Both are no-ops off Electron: there is no
 * executor to sync with, and `available` says so.
 */

/** Pushes the session to the main process whenever it changes, including
 * to null on sign-out — which is why this lives above the auth gate rather
 * than inside AppShell: AppShell unmounts the moment the token clears, and
 * an effect that unmounts with it never gets to send the null. */
export function useLocalExecutorSync(token: string | null): void {
  useEffect(() => {
    const bridge = electronBridge();
    if (!bridge) return;
    void bridge.executor.setSession(token).catch(() => undefined);
  }, [token]);
}

export interface LocalExecutor {
  /** True only in the desktop app. */
  available: boolean;
  state: ExecutorState['state'] | null;
  reason: string | null;
  executorId: string | null;
  name: string | null;
  roots: string[];
  /** Opens the native folder dialog; resolves with the new root, or null if
   * the user cancelled. */
  pickDirectory: () => Promise<string | null>;
  removeRoot: (dir: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useLocalExecutor(): LocalExecutor {
  const bridge = electronBridge();
  const [state, setState] = useState<ExecutorState | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setState(await bridge.executor.getState());
    } catch {
      setState(null);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    return bridge.executor.onState(setState);
  }, [bridge, refresh]);

  const pickDirectory = useCallback(async () => {
    if (!bridge) return null;
    const result = await bridge.executor.pickDirectory();
    await refresh();
    return 'canceled' in result ? null : result.path;
  }, [bridge, refresh]);

  const removeRoot = useCallback(
    async (dir: string) => {
      if (!bridge) return;
      setState(await bridge.executor.removeRoot(dir));
    },
    [bridge],
  );

  return {
    available: bridge !== null,
    state: state?.state ?? null,
    reason: state?.reason ?? null,
    executorId: state?.executorId ?? null,
    name: state?.name ?? null,
    roots: state?.roots ?? [],
    pickDirectory,
    removeRoot,
    refresh,
  };
}
