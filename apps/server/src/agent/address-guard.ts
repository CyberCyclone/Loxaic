/**
 * Which addresses a model-chosen URL may reach (web_fetch, the browser's
 * request interception, the sandbox egress proxy, MCP URLs).
 */
import { lookup as dnsLookup, promises as dns, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch, type RequestInit, type Response } from "undici";

/**
 * True for addresses that must never be reachable from a model-chosen URL:
 * loopback, link-local, and the RFC1918 / carrier-grade / benchmarking
 * ranges that make up a typical private network.
 */
export function isBlockedAddress(ip: string, family: number): boolean {
  if (family === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;     // RFC1918
    if (a === 192 && b === 168) return true;              // RFC1918
    if (a === 192 && b === 0) return true;                // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                            // multicast + reserved
    return false;
  }
  const bytes = ipv6Bytes(ip);
  // Unparseable is refused, like a malformed IPv4 above: the guard's answer for
  // an address it cannot read must never be "public".
  if (!bytes) return true;
  const word = (i: number): number => (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  const embeddedV4 = (at: number): string => bytes.slice(at, at + 4).join(".");
  const zeroPrefix = (n: number): boolean => bytes.slice(0, n).every((b) => b === 0);
  // Every way an IPv4 address can ride inside an IPv6 one is unwrapped and the
  // IPv4 checked: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d, which also
  // covers :: and ::1), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
  // The IPv4-translated form (::ffff:0:a.b.c.d, RFC 2765) has no real use, so
  // all of it is refused rather than unwrapped.
  // Matching spellings was the old bug: getaddrinfo and the URL parser both
  // hand back `::ffff:7f00:1` for 127.0.0.1, which no pattern on the dotted
  // form ever saw.
  const mapped = zeroPrefix(10) && word(5) === 0xffff;                     // ::ffff:0:0/96
  const translated = zeroPrefix(8) && word(4) === 0xffff && word(5) === 0; // ::ffff:0:0:0/96
  if (translated) return true;
  if (mapped) return isBlockedAddress(embeddedV4(12), 4);
  if (zeroPrefix(12)) return isBlockedAddress(embeddedV4(12), 4);
  if (word(0) === 0x64 && word(1) === 0xff9b) {
    // 64:ff9b:1::/48 is local-use NAT64: whatever it translates to is a choice
    // of this network, so none of it is public.
    if (word(2) !== 0) return true;
    return isBlockedAddress(embeddedV4(12), 4);
  }
  if (word(0) === 0x2002) return isBlockedAddress(embeddedV4(2), 4);
  if (word(0) === 0x2001 && word(1) === 0) return true;          // Teredo: obfuscated IPv4 inside
  if (word(0) === 0x2001 && word(1) === 0xdb8) return true;      // documentation
  if ((word(0) & 0xfff0) === 0x3ff0) return true;                // documentation, 3fff::/20 (RFC 9637)
  if (word(0) === 0x2001 && word(1) === 2 && word(2) === 0) return true; // benchmarking 2001:2::/48
  if (word(0) === 0x5f00) return true;                           // SRv6 SIDs, 5f00::/16
  if (word(0) === 0x100 && word(1) === 0 && word(2) === 0 && word(3) === 0) return true; // discard-only 100::/64
  if ((bytes[0] & 0xfe) === 0xfc) return true;                   // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site local (deprecated, still routed by some)
  if (bytes[0] === 0xff) return true;                            // multicast
  return false;
}

/**
 * An IPv6 address as its 16 bytes, or null if it is not one. Accepts every
 * spelling: `::` compression, a trailing dotted IPv4, leading zeros, upper
 * case, brackets, and a zone id (`fe80::1%eth0`), which says which interface
 * and nothing about where the address points.
 */
function ipv6Bytes(raw: string): number[] | null {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!isIP(ip)) return null;
  let tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    tail = dotted[1].split(".").map(Number);
    ip = `${ip.slice(0, dotted.index)}:0:0`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((h) => Number.parseInt(h, 16)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const words = [...head, ...Array<number>(fill).fill(0), ...rest];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Every A/AAAA record must be public — one private answer is enough to
  // reach an internal service, so a mixed result is rejected outright.
  const records = await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`could not resolve host: ${host}`);
  });
  if (records.length === 0) throw new Error(`could not resolve host: ${host}`);
  for (const r of records) {
    if (isBlockedAddress(r.address, r.family)) {
      throw new Error(`refusing to fetch a private or loopback address (${host} → ${r.address})`);
    }
  }
}

/** A request the guard refused. Distinct from a network failure so callers can
 * say "that address is not reachable from here" rather than "it is down". */
export class BlockedTargetError extends Error {}

/** What `guardedFetch` answers with (undici's Response, not the global one). */
export type GuardedResponse = Response;

const DNS_TIMEOUT_MS = 5_000;

/**
 * e2e only: `host:port` pairs the guard lets through, so a spec can fetch its
 * own fixture sites on loopback: an IP literal, or `localhost` for a second
 * fixture that needs a different host (cookies are per host, not per port).
 * Honoured only with the mock backend, which no real deployment runs.
 */
function testAllowed(host: string, port: string): boolean {
  if (process.env.MOCK_INFERENCE !== "true") return false;
  const list = (process.env.LOXAIC_E2E_FETCH_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(`${host}:${port}`);
}

/**
 * The resolver every guarded connection uses. Resolving here, inside the
 * connect, is the point: the address checked is the address dialled, so a name
 * that answers public for a check and private for the connection (DNS
 * rebinding) has nothing to exploit. Every record must be public; one private
 * answer refuses the lot.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    callback(new Error(`could not resolve host: ${hostname} (timed out)`), "", 0);
  }, DNS_TIMEOUT_MS);
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err || addresses.length === 0) {
      callback(err ?? new Error(`could not resolve host: ${hostname}`), "", 0);
      return;
    }
    const blocked = addresses.find((a) => isBlockedAddress(a.address, a.family));
    if (blocked) {
      callback(new BlockedTargetError(`refusing to fetch a private or loopback address (${hostname} → ${blocked.address})`), "", 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const guardedAgent = new Agent({
  connect: { lookup: guardedLookup, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
});

/**
 * One request to a model-chosen URL, with the address checked at connect time.
 *
 * Never follows a redirect: the caller decides whether to request the next hop,
 * and that request is checked again. An IP literal never reaches the resolver,
 * so it is checked here.
 */
export async function guardedFetch(url: URL, init: Omit<RequestInit, "dispatcher" | "redirect"> = {}): Promise<Response> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError(`only http and https URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (host === "localhost" && testAllowed(host, port)) {
    return await fetch(url, { ...init, redirect: "manual" });
  }
  if (family !== 0) {
    if (isBlockedAddress(host, family) && !testAllowed(host, port)) {
      throw new BlockedTargetError(`refusing to fetch a private or loopback address (${host})`);
    }
  }
  try {
    return await fetch(url, { ...init, redirect: "manual", dispatcher: guardedAgent });
  } catch (err) {
    // undici wraps the connect error; surface the guard's own refusal.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof BlockedTargetError) throw cause;
    throw err;
  }
}
