/**
 * `null` for "cleared", an `Error` for "not an address", the cleaned-up URL
 * otherwise.
 *
 * A bare hostname is accepted and gets `https://`, because that is what people
 * paste — a tailnet address copied from the host's own status card has no
 * scheme on it, and refusing it would be pedantry rather than safety.
 */
export function normalizeUrl(raw: string): string | Error | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return new Error("That doesn't look like an address.");
  }
  if (!parsed.hostname) return new Error("That doesn't look like an address.");
  // Trailing slashes are stripped because every caller appends its own path;
  // `${url}/health` against "https://host/" would ask for "//health".
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
