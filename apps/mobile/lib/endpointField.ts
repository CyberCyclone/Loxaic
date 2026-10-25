/**
 * What Settings' server-address field shows, and what it says underneath.
 *
 * `override` is the stored `loxaic-endpoint`, the one key `resolveEndpoint`
 * honours — whichever screen wrote it, Settings or the sign-in screen's
 * server picker. The field used to be bound to a copy kept in
 * `loxaic-settings` instead, which only Settings wrote: an address set at
 * sign-in showed as an empty field over an app pinned to it, and saving any
 * other setting then wrote the empty copy back, removing the override.
 *
 * That copy is deliberately not an input. Settings always wrote both keys
 * together, so the only installs where the copy is set and the override is
 * not are those whose override was cleared since — from the picker, or by a
 * desktop Disconnect — and there the copy names a server the app is no
 * longer using.
 *
 * `active` is the server in use. With no override it is what auto-detection
 * found, and it goes in `detected`, never in `value`: as the value, Saving
 * would quietly turn a detected address into a pinned one.
 */
export function endpointField({
  override,
  active,
}: {
  override: string | null;
  active: string | null;
}): { value: string; detected: string | null } {
  const pinned = override?.trim();
  if (pinned) return { value: pinned, detected: null };
  const found = active?.trim();
  if (found) return { value: '', detected: found };
  return { value: '', detected: null };
}
