/**
 * `null` for "cleared", an `Error` for "not an address", the cleaned-up URL
 * otherwise.
 *
 * A bare address is accepted and given a scheme, because that is what people
 * paste — a tailnet name copied from the host's own status card has none on
 * it, and refusing it would be pedantry rather than safety. Which scheme is
 * the judgement: a name with a dot in it (`box.tail1234.ts.net`) gets
 * `https://`, since every tailnet, Funnel and domain-fronted server is TLS;
 * a literal IP or a dotless host (`192.168.1.20:4100`, `localhost`, `box`)
 * gets `http://`, since that is a machine on your own network, where the
 * self-contained server listens on plain HTTP. Defaulting everything to
 * https turned the LAN case — which the picker's own help text advertises —
 * into "Could not reach it." with no hint that the scheme had been guessed,
 * and Save does not test. An explicit scheme is always kept as typed.
 */
export function normalizeUrl(raw: string): string | Error | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultScheme(trimmed)}://${trimmed}`;
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

/** `http` for a literal IP or a dotless host, `https` for a domain name. */
function defaultScheme(hostAndMaybePort: string): 'http' | 'https' {
  const host = hostAndMaybePort.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const literalIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  return literalIp || !host.includes('.') ? 'http' : 'https';
}
