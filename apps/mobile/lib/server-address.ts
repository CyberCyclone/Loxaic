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

/**
 * A sentence to add when an address could not be reached and it is a
 * Tailscale address, or `null` for any other address.
 *
 * The usual reason a tailnet address fails from a phone is not the address:
 * Tailscale is switched off on the phone, so the name does not resolve and a
 * 100.x address routes nowhere. A bare "Could not reach it." sends someone
 * off re-typing an address that was right all along. A Funnel address is also
 * `*.ts.net` and is public, which is why this says "make sure" rather than
 * claiming the device is disconnected.
 */
export function tailnetHint(url: string | null | undefined): string | null {
  return url && isTailnetAddress(url)
    ? 'This is a Tailscale address, so make sure Tailscale is connected on this device.'
    : null;
}

/** A MagicDNS name (`*.ts.net`), or an IPv4 address in Tailscale's 100.64.0.0/10. */
function isTailnetAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  if (host.endsWith('.ts.net')) return true;
  // Only 100.64–100.127: the rest of 100.0.0.0/8 is ordinary public space.
  const octets = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return octets !== null && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}

/** `http` for a literal IP or a dotless host, `https` for a domain name. */
function defaultScheme(hostAndMaybePort: string): 'http' | 'https' {
  const host = hostAndMaybePort.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const literalIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  return literalIp || !host.includes('.') ? 'http' : 'https';
}
