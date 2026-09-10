import { useCallback, useState } from 'react';
import { useUpdates } from 'expo-updates';
import {
  applyChannel,
  checkNow,
  isSupported,
  restartIntoUpdate,
  versionInfo,
  type VersionInfo,
} from '@/lib/expo-updates';
import {
  setUpdateChannel,
  useUpdateChannel,
  type UpdateChannel,
} from '@/lib/update-channel';
import { useServerConfig } from './useServerConfig';

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface AppUpdates {
  /** False where this app cannot update itself: web, Expo Go, development.
   * The whole settings row hides on false. */
  supported: boolean;
  channel: UpdateChannel;
  setChannel: (channel: UpdateChannel) => void;
  check: () => void;
  /** Restart into the downloaded update. Only meaningful at `ready`. */
  install: () => void;
  status: UpdateStatus;
  /** A sentence for the person, when something went wrong. */
  error: string | null;
  version: VersionInfo | null;
  /** The server's own version, for spotting skew against this app's. */
  serverVersion: string | null;
}

/**
 * One view of "can this app update itself, and what is it running", whichever
 * layer answers it.
 *
 * Today that layer is expo-updates on native. The desktop app updates through
 * a different mechanism entirely (a whole new binary, not a JS bundle), and
 * this is the seam it plugs into — so the settings row is written once,
 * against this shape, rather than once per platform.
 */
export function useAppUpdates(): AppUpdates {
  const supported = isSupported();
  const channel = useUpdateChannel();
  const { config } = useServerConfig();

  // expo-updates' own hook: the states it reports (checking, downloading) are
  // the ones this cannot observe from the outside, since checkNow() awaits
  // both halves in one call.
  const { isChecking, isDownloading, isUpdatePending, checkError, downloadError } = useUpdates();
  const [localError, setLocalError] = useState<string | null>(null);

  const setChannel = useCallback((next: UpdateChannel) => {
    // Applied before it is stored: if this build cannot switch — a locally
    // built release without the header embedded — the preference must not be
    // left claiming a channel the app is not actually following.
    const applied = applyChannel(next);
    if (!applied.ok) {
      setLocalError(applied.reason ?? 'Could not switch channel.');
      return;
    }
    setLocalError(null);
    setUpdateChannel(next);
  }, []);

  const check = useCallback(() => {
    setLocalError(null);
    void checkNow().then((result) => {
      if (result.error) setLocalError(result.error);
    });
  }, []);

  const install = useCallback(() => {
    void restartIntoUpdate().catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const error = localError ?? checkError?.message ?? downloadError?.message ?? null;
  const status: UpdateStatus = isChecking
    ? 'checking'
    : isDownloading
      ? 'downloading'
      : isUpdatePending
        ? 'ready'
        : error
          ? 'error'
          : 'idle';

  return {
    supported,
    channel,
    setChannel,
    check,
    install,
    status,
    error,
    version: supported ? versionInfo() : null,
    serverVersion: config?.version ?? null,
  };
}
