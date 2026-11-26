/**
 * Whether a settings screen whose prefs could not be loaded asks again: only
 * as the server comes back (unreachable, then reachable). Not on every render
 * while it is reachable, or a server that answers with an error would be
 * asked in a loop.
 */
export function reloadPrefsNow(input: { wasReachable: boolean; reachable: boolean; loaded: boolean }): boolean {
  return !input.loaded && input.reachable && !input.wasReachable;
}
