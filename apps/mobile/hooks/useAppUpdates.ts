import { useCallback, useEffect, useState } from 'react';
import {
  checkNow,
  isSupported,
  restartIntoUpdate,
  useUpdateState,
  versionInfo,
  type VersionInfo,
} from '@/lib/expo-updates';
import { electronBridge, type DesktopUpdateState } from '@/lib/endpoint';

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface AppUpdates {
  /** False where this app cannot update itself at all: web in a browser,
   * Expo Go, development on native. The whole settings row hides on false. */
  supported: boolean;
  check: () => void;
  /** Restart into the downloaded update. Only meaningful at `ready`. */
  install: () => void;
  status: UpdateStatus;
  /** A sentence for the person, when something went wrong or when the app
   * can update in principle but is not checking (a development build, a
   * `.deb` install). */
  error: string | null;
  /** 0-1 while downloading, where the backend reports it. */
  progress: number | null;
  version: VersionInfo | null;
}

/**
 * One view of "can this app update itself, and what is it running", whichever
 * layer answers it.
 *
 * Two layers do, and they have nothing in common underneath: expo-updates
 * fetches a JS bundle over the air on native, while the desktop app downloads
 * a whole new binary and hands it to the platform's installer. What a person
 * decides is the same in both cases — check now, restart — so the settings
 * row and the banner are written once, against this shape. Which channel an
 * install follows is not among those decisions: it is fixed when the app is
 * built, so dev, beta and production are separate apps.
 *
 * Both backends are read unconditionally and one is selected, rather than
 * branching over which hook to call: whether a desktop bridge exists is fixed
 * for the life of the process, but hooks may not be called conditionally on
 * anything, and expo-updates' web implementation is inert rather than absent.
 */
export function useAppUpdates(): AppUpdates {
  const desktop = useDesktopUpdates();
  const expo = useExpoUpdates();
  return desktop ?? expo;
}

type Backend = AppUpdates;

/** The Electron main process's updater, or null when there is no desktop
 * bridge — i.e. everywhere but the desktop app. */
function useDesktopUpdates(): Backend | null {
  const bridge = electronBridge();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  // A rejected IPC call — updates.json unwritable, the install step failing
  // — used to vanish into a `void`: the pill stayed where it was and the
  // person reasonably believed their choice had stuck.
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const failed = (err: unknown) => { setBridgeError(err instanceof Error ? err.message : String(err)); };

  useEffect(() => {
    const updates = bridge?.updates;
    if (!updates) return;
    let live = true;
    void updates.getState().then((s) => { if (live) setState(s); });
    const off = updates.onState(setState);
    return () => { live = false; off(); };
  }, [bridge]);

  const check = useCallback(() => {
    setBridgeError(null);
    bridge?.updates.check().then(setState).catch(failed);
  }, [bridge]);
  const install = useCallback(() => {
    setBridgeError(null);
    bridge?.updates.install().then(setState).catch(failed);
  }, [bridge]);

  if (!bridge?.updates) return null;

  return {
    // True even when checks are off. A desktop build that is not checking is
    // still a build that updates — saying so, with the reason, is the only
    // way a person can tell it apart from one that is up to date.
    supported: true,
    check,
    install,
    status: bridgeError ? 'error' : (state?.status ?? 'idle'),
    error: bridgeError ?? state?.error ?? state?.disabledReason ?? null,
    progress: state?.progress ?? null,
    version: state
      ? {
          appVersion: state.version,
          // A desktop update replaces the whole binary, so there is no second
          // version to report and no update id: the version *is* the build.
          nativeVersion: null,
          nativeBuild: null,
          updateId: null,
          // Which desktop app this is. "Loxaic Beta" is a separate
          // application, so this is a fact about the install rather than a
          // setting, and the row names it only when it is not the ordinary one.
          // (It supersedes the stored channel the previous commit surfaced:
          // there is no longer a channel to store.)
          channel: state.variant === 'beta' ? 'beta' : null,
          runtimeVersion: null,
          isEmbedded: false,
        }
      : null,
  };
}

/** expo-updates on native; inert everywhere else. */
function useExpoUpdates(): Backend {
  const supported = isSupported();

  // expo-updates' own hook, through the one module allowed to import it: the
  // states it reports (checking, downloading) are the ones this cannot
  // observe from the outside, since checkNow() awaits both halves in one call.
  const { isChecking, isDownloading, isUpdatePending, checkError, downloadError } = useUpdateState();
  const [localError, setLocalError] = useState<string | null>(null);

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
  // An error outranks a pending update. `isUpdatePending` stays true from a
  // completed download until the app reloads, so tested first it made every
  // later error unreachable — a failed check rendered as "An update is ready"
  // and the person never learned something had gone wrong. A staged update is
  // less urgent than a thing that just went wrong.
  const status: UpdateStatus = isChecking
    ? 'checking'
    : isDownloading
      ? 'downloading'
      : error
        ? 'error'
        : isUpdatePending
          ? 'ready'
          : 'idle';

  return {
    supported,
    check,
    install,
    status,
    error,
    // expo-updates reports no byte progress for a bundle download.
    progress: null,
    version: supported ? versionInfo() : null,
  };
}
