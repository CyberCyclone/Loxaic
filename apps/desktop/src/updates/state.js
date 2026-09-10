/**
 * The desktop updater's state, as a pure reducer over the events
 * electron-updater emits.
 *
 * Separate from the updater itself so the interesting decisions — when an
 * error clears, what a check does to an update that is already downloaded —
 * are testable without electron, a network, or a signed build. There is no
 * `require("electron")` anywhere in this file, deliberately.
 */

/** The channel names, shared with the mobile app's own update row so one
 * settings component can serve both. */
export const CHANNELS = ["production", "beta"];

export function initialState({ version = null, channel = "production", enabled = true, disabledReason = null } = {}) {
  return {
    enabled,
    // Why not, in words, when not: "checks are off" with no reason reads as a
    // bug rather than as a development build behaving correctly.
    disabledReason: enabled ? null : disabledReason,
    channel,
    status: enabled ? "idle" : "off",
    /** The version that was found, or downloaded — not the running one. */
    availableVersion: null,
    /** 0-1 while downloading, null otherwise. */
    progress: null,
    error: null,
    version,
  };
}

/**
 * Applies one event.
 *
 * Two rules here are worth more than they look:
 *
 *   - **A new check clears the previous error.** Update checks fail for
 *     ordinary transient reasons (no network on a laptop that just woke), and
 *     an error that never clears turns a passing failure into a permanent
 *     accusation in Settings.
 *
 *   - **A downloaded update is sticky.** The six-hourly check keeps running
 *     after one has been downloaded, and its `checking` / `not-available`
 *     events would otherwise walk "an update is ready, restart to apply" back
 *     off the screen — for an update that is still sitting on disk, still
 *     ready, and still applied on the next restart.
 */
export function reduce(state, event) {
  if (!state.enabled) {
    // Nothing runs when the updater is off, but the channel is still a stored
    // preference someone can set — they may be about to install a build that
    // does update.
    return event.type === "channel" ? { ...state, channel: event.channel } : state;
  }
  switch (event.type) {
    case "checking":
      return state.status === "ready"
        ? { ...state, error: null }
        : { ...state, status: "checking", error: null, progress: null };
    case "available":
      return state.status === "ready"
        ? state
        : { ...state, status: "downloading", availableVersion: event.version ?? null, progress: 0 };
    case "not-available":
      return state.status === "ready" ? state : { ...state, status: "idle", availableVersion: null, progress: null };
    case "progress":
      return state.status === "ready"
        ? state
        : { ...state, status: "downloading", progress: clampFraction(event.percent) };
    case "downloaded":
      return {
        ...state,
        status: "ready",
        availableVersion: event.version ?? state.availableVersion,
        progress: 1,
        error: null,
      };
    case "error":
      // An error after a successful download is a *later* check failing, and
      // says nothing about the update already on disk. Keep the offer.
      return state.status === "ready"
        ? state
        : { ...state, status: "error", progress: null, error: event.message || "The update check failed." };
    case "channel":
      // A channel switch invalidates what the previous channel had found: the
      // build that was on offer may not exist on the new one at all.
      return { ...state, channel: event.channel, status: "idle", availableVersion: null, progress: null, error: null };
    default:
      return state;
  }
}

/** electron-updater reports percent as 0-100 and occasionally overshoots on
 * the last chunk; the renderer wants a fraction it can trust. */
function clampFraction(percent) {
  if (typeof percent !== "number" || Number.isNaN(percent)) return null;
  return Math.min(1, Math.max(0, percent / 100));
}
