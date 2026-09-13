import { AppState, Platform, type AppStateStatus } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';

/**
 * Over-the-air updates, for native release builds. The only file that imports
 * `expo-updates`, so everything else can be written without guarding for the
 * platforms where updates do not exist at all.
 *
 * Two facts about expo-updates shape this:
 *
 *   1. Every API here throws in Expo Go and in development, where there is no
 *      update system to talk to. So nothing runs unless `isSupported()`.
 *
 *   2. The channel is embedded in the build (`app.config.js` writes it from
 *      `APP_VARIANT`), so `Updates.channel` is simply the truth about this
 *      install — dev, beta and production are separate apps. There was once a
 *      runtime override here, which made "which channel is this on?" a
 *      question with two possible answers; nothing overrides it now.
 */

/**
 * Whether this build can update itself at all.
 *
 * `Updates.isEnabled` is false in development and when the config is
 * unusable; `storeClient` is Expo Go, where the module exists but every call
 * rejects.
 *
 * Web is excluded *explicitly*, and must stay that way: expo-updates' web
 * shim hardcodes `isEnabled = true` while implementing none of this — it has
 * no `setUpdateRequestHeadersOverride` at all, and its `reload()` is a page
 * refresh. There is nothing to update either, since the server serves the web
 * app and it changes when the server does. Caught by the e2e spec, which is
 * the only place that runs this code on web.
 */
export function isSupported(): boolean {
  return (
    Platform.OS !== 'web' &&
    Updates.isEnabled &&
    !__DEV__ &&
    Constants.executionEnvironment !== ExecutionEnvironment.StoreClient
  );
}

/** Automatic checks are throttled to this; "Check now" is not. Foregrounding
 * an app that is opened many times a day should not mean an update request
 * every time. */
const AUTO_CHECK_INTERVAL_MS = 15 * 60 * 1000;

let lastAutoCheck = 0;
let inFlight: Promise<CheckResult> | null = null;

export interface CheckResult {
  /** True when an update was found *and* downloaded — it applies on the next
   * reload, which is the banner's cue. */
  ready: boolean;
  error?: string;
}

/**
 * Asks whether there is an update and, if so, downloads it. Deliberately
 * never reloads: taking someone's screen away mid-sentence is not a decision
 * this layer gets to make. The banner offers a restart instead.
 *
 * Single-flighted — a foreground event landing while a manual check is in
 * flight must not start a second one against the same endpoint.
 */
export async function checkNow({ auto = false }: { auto?: boolean } = {}): Promise<CheckResult> {
  if (!isSupported()) return { ready: false };
  if (auto && Date.now() - lastAutoCheck < AUTO_CHECK_INTERVAL_MS) return { ready: false };
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<CheckResult> => {
    try {
      if (auto) lastAutoCheck = Date.now();
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) return { ready: false };
      const fetched = await Updates.fetchUpdateAsync();
      return { ready: fetched.isNew };
    } catch (err) {
      return { ready: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Restarts into the update that was downloaded. */
export async function restartIntoUpdate(): Promise<void> {
  if (!isSupported()) return;
  await Updates.reloadAsync();
}

/**
 * Starts checking: once now, and again whenever the app comes back to the
 * foreground — the two moments an update is worth having and nobody is
 * mid-thought. Returns an unsubscribe.
 *
 * Mounted above the auth gate (see app/_layout.tsx): a fix for a bug that
 * *prevents* signing in is exactly the one a signed-out user needs. It reads
 * nothing from storage, so it does not wait for hydration either.
 */
export function startUpdateChecks(): () => void {
  if (!isSupported()) return () => undefined;

  // One-shot clear, kept for a release cycle. The override this removes was
  // stored *natively*, not in JS, so a build made while the switch existed
  // could still be carrying one — and with the switch gone nothing would
  // re-apply it and nothing would clear it. That install would follow beta
  // for the life of the binary while `Updates.channel` — and so every bug
  // report it produced — said production: exactly the two-answers problem
  // this change exists to end, made permanent and invisible.
  try {
    Updates.setUpdateRequestHeadersOverride(null);
  } catch {
    // A build that never embedded the header throws here, and has no override
    // to clear in the first place.
  }

  void checkNow({ auto: true });

  const onAppState = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void checkNow({ auto: true });
  });

  return () => {
    onAppState.remove();
  };
}

export interface VersionInfo {
  /** The JS bundle's own version — after an update, the *update's*. */
  appVersion: string | null;
  /** The installed binary's version, which an update cannot change. */
  nativeVersion: string | null;
  nativeBuild: string | null;
  /** Short form of the running update's id; null on the embedded bundle. */
  updateId: string | null;
  /** The channel this install follows, fixed when it was built. */
  channel: string | null;
  runtimeVersion: string | null;
  /** True when running the bundle that shipped inside the binary. */
  isEmbedded: boolean;
}

/**
 * What this install is actually running. Both versions are reported because
 * they diverge: an update changes the JS bundle's version while the binary
 * stays where it was, and when a beta tester says "it doesn't work on 1.2.3"
 * the binary is what decides which native code they have.
 */
export function versionInfo(): VersionInfo {
  return {
    appVersion: Constants.expoConfig?.version ?? null,
    nativeVersion: Application.nativeApplicationVersion,
    nativeBuild: Application.nativeBuildVersion,
    updateId: Updates.updateId ? Updates.updateId.slice(0, 8) : null,
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    isEmbedded: Updates.isEmbeddedLaunch,
  };
}

/** The live check/download state, for a component that needs to render it. */
export interface UpdateState {
  isChecking: boolean;
  isDownloading: boolean;
  isUpdatePending: boolean;
  checkError: Error | null;
  downloadError: Error | null;
}

const INERT_UPDATE_STATE: UpdateState = {
  isChecking: false,
  isDownloading: false,
  isUpdatePending: false,
  checkError: null,
  downloadError: null,
};

/**
 * expo-updates' own `useUpdates()`, behind this module's guard.
 *
 * This is the one thing here that cannot be gated by an early return: it is
 * a hook, so it has to be called on every render regardless. What can be
 * guarded is what it *reports* — everything it says is masked to inert
 * values where updates do not exist, so no component ever renders the web
 * shim's (or Expo Go's) idea of the state. Keeping the call in this file is
 * what keeps "lib/expo-updates.ts is the only importer of expo-updates" true
 * rather than true-except-for-that-one-hook.
 */
export function useUpdateState(): UpdateState {
  const live = useUpdates();
  if (!isSupported()) return INERT_UPDATE_STATE;
  return {
    isChecking: live.isChecking,
    isDownloading: live.isDownloading,
    isUpdatePending: live.isUpdatePending,
    checkError: live.checkError ?? null,
    downloadError: live.downloadError ?? null,
  };
}
