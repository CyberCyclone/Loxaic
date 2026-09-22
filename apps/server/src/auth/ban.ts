/**
 * Whether a user row's ban is in force. An expired ban counts as lifted,
 * mirroring better-auth's own auto-unban.
 *
 * One predicate, used by the middleware that enforces it and the admin user
 * list that reports it — the list once re-derived it as `banned === true` and
 * badged accounts "Suspended" that signed in and worked normally.
 */
export function isBanned(user: { banned?: boolean | null; banExpires?: Date | string | null }): boolean {
  if (!user.banned) return false;
  if (user.banExpires && new Date(user.banExpires).getTime() < Date.now()) return false;
  return true;
}
