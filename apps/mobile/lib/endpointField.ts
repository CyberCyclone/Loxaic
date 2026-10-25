/**
 * What Settings' server-address field shows, and what it says underneath.
 *
 * The field edits the stored `loxaic-endpoint`, the one key
 * `resolveEndpoint` honours — whichever screen wrote it, Settings or the
 * sign-in screen's server picker. It used to be bound to a copy kept in
 * `loxaic-settings` instead, which only Settings wrote: an address set at
 * sign-in showed as an empty field over an app pinned to it, and saving any
 * other setting then wrote the empty copy back, removing the override.
 *
 * That copy is deliberately not an input. Settings always wrote both keys
 * together, so the only installs where the copy is set and the override is
 * not are those whose override was cleared since — from the picker, or by a
 * desktop Disconnect — and there the copy names a server the app is no
 * longer using. `withoutStaleEndpoint` drops it on the next save.
 */

/** The field's value on opening: the override, or empty when there is none. */
export function endpointFieldValue(override: string | null): string {
  return override?.trim() ?? '';
}

/**
 * The server in use, to name under the field — or null when the field already
 * says it, or is about to.
 *
 * Only with nothing pinned (`saved` empty) and nothing typed (`draft` empty):
 * under an address being typed, "using X" would read as contradicting it.
 * And never as the field's value, where Save would quietly turn a detected
 * address into a pinned one.
 *
 * On the desktop the address was not detected: the main process hands over
 * the one onboarding set up (a Solo or Host's own server, a Client's host).
 */
export function endpointInUse({
  saved,
  draft,
  active,
  desktop,
}: {
  saved: string;
  draft: string;
  active: string | null;
  desktop: boolean;
}): { url: string; source: 'detected' | 'setup' } | null {
  if (saved.trim() || draft.trim()) return null;
  const url = active?.trim();
  if (!url) return null;
  return { url, source: desktop ? 'setup' : 'detected' };
}

/** Settings as saved: without the `endpoint` copy older builds kept in it. */
export function withoutStaleEndpoint<T extends object>(settings: T): Omit<T, 'endpoint'> {
  const { endpoint: _stale, ...rest } = settings as T & { endpoint?: unknown };
  return rest;
}
