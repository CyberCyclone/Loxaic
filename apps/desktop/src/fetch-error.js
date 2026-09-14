// Turns a failed `fetch` into a sentence someone can act on.
//
// Node's fetch reports every network failure as `TypeError: fetch failed` and
// hides the reason on `err.cause` — so a probe that showed `err.message` told
// a person "fetch failed" whether the address was wrong, nothing was listening,
// or macOS had refused the connection before it left the machine. The last one
// is the case that matters most and is least guessable: since macOS 15, a
// third-party app needs Local Network permission to reach a LAN address, and
// without it the connection fails with EHOSTUNREACH while `curl` in Terminal
// (exempt) succeeds against the very same URL.

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [169, 254, 0, 0, 16],
];

function isLocalNetworkHost(hostname) {
  if (hostname.endsWith(".local")) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const ip = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ip & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * @param {unknown} err  what `fetch` threw
 * @param {{ url?: string, appName?: string, platform?: string }} [opts]
 */
export function describeFetchError(err, { url, appName = "this app", platform = process.platform } = {}) {
  let hostname = "";
  let where = "the server";
  try {
    if (url) {
      const u = new URL(url);
      hostname = u.hostname;
      where = u.host;
    }
  } catch {
    // An unparseable URL keeps the generic wording; the probe reports it anyway.
  }

  const e = /** @type {any} */ (err);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `${where} did not answer in time. Check the address, and that this computer is on the same network.`;
  }

  const code = e?.cause?.code;
  switch (code) {
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      if (platform === "darwin" && isLocalNetworkHost(hostname)) {
        return (
          `Can't reach ${where}. macOS may be blocking ${appName} from your local network: ` +
          `turn it on in System Settings → Privacy & Security → Local Network, then press Check again.`
        );
      }
      return `No route to ${where}. Check that this computer is on the same network.`;
    case "ECONNREFUSED":
      return `${where} refused the connection — nothing is listening on that port.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${hostname || where} doesn't resolve to an address. Check the spelling.`;
    default:
      break;
  }

  if (e?.cause?.message) return `${e.message}: ${e.cause.message}`;
  return err instanceof Error ? err.message : String(err);
}

export { isLocalNetworkHost };
