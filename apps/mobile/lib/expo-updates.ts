import { AppState, Platform, type AppStateStatus } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { readUpdateChannel, subscribeUpdateChannel, type UpdateChannel } from './update-channel';

/**
 * Over-the-air updates, for native release builds. The only file that imports
 * `expo-updates`, so everything else can be written without guarding for the
 * platforms where updates do not exist at all.
 *
 * The shape of this is decided by two facts about expo-updates:
 *
 *   1. Every API here throws in Expo Go and in development, where there is no
 *      update system to talk to. So nothing runs unless `isSupported()`.
 *
 *   2. The channel is a *request header*, set at runtime. One production
 *      binary can therefore follow either channel, which is what makes "opt
 *      into beta" a switch rather than a separate app. `Updates.channel`
 *      reports what the binary was *built* for and never changes, so the
 *      stored preference — not that constant — is the source of truth, and it
 *      is re-applied on every launch.
 */

/** Production is the built-in channel, so it is the *absence* of an override
 * rather than a header of its own. Passing null is what restores it. */
function headersFor(channel: UpdateChannel): Record<string, string> | null {
  return channel === 'beta' ? { 'expo-channel-name': 'beta' } : null;
}

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

export interface ApplyResult {
  ok: boolean;
  /** Why the channel could not be applied, in words a person can act on. */
  reason?: string;
}

/**
 * Points this install at a channel's updates, now.
 *
 * Only the keys already embedded in the build's own `updates.requestHeaders`
 * can be overridden (expo-updates enforces this), which is why app.json
 * declares `expo-channel-name` even though EAS Build would inject it anyway:
 * a locally-built release — the e2e's, or anyone's `expo run:ios
 * --configuration Release` — would otherwise throw here.
 */
export function applyChannel(channel: UpdateChannel): ApplyResult {
  if (!isSupported()) return { ok: false, reason: 'This build does not receive updates.' };
  try {
    Updates.setUpdateRequestHeadersOverride(headersFor(channel));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error && /header/i.test(err.message)
          ? 'This build cannot switch channels. Install a build from the release pipeline to use beta.'
          : `Could not switch channel: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
 * Applies the stored channel and starts checking: once now, and again
 * whenever the app comes back to the foreground — the two moments an update
 * is worth having and nobody is mid-thought. Returns an unsubscribe.
 *
 * Mounted above the auth gate (see app/_layout.tsx): a fix for a bug that
 * *prevents* signing in is exactly the one a signed-out user needs.
 */
export function startUpdateChecks(): () => void {
  if (!isSupported()) return () => undefined;

  applyChannel(readUpdateChannel());
  void checkNow({ auto: true });

  const onChannelChange = subscribeUpdateChannel(() => {
    applyChannel(readUpdateChannel());
    // A deliberate channel switch is a reason to look straight away, so this
    // check is not the throttled one.
    void checkNow();
  });

  const onAppState = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void checkNow({ auto: true });
  });

  return () => {
    onChannelChange();
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
  /** The channel the binary was built for — not the one in force. */
  builtForChannel: string | null;
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
    builtForChannel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    isEmbedded: Updates.isEmbeddedLaunch,
  };
}
