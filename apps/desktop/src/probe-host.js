// The client form's Check: does a Loxaic answer at this address, and which
// of the addresses it could mean is the one that answers?
//
// Kept out of main.js, which cannot be imported under test, because the order
// and the stopping rules are the decisions here. An address typed without a
// scheme is tried as https:// and then http://, and dropping to http:// sends
// the password and session cookie in the clear from then on, so it happens
// only when https:// failed in a way that means nothing speaks TLS there:
// nothing listening, or a plain-HTTP server answering the TLS hello. A bad
// certificate, a reset or a timeout is reported instead: those are the
// failures an attacker on the network can cause, and the fix for each is on
// the server, not a quiet downgrade. Even a fallback that happens is flagged,
// so the form can say so.

/** OpenSSL and BoringSSL name a plaintext reply to a TLS hello differently. */
const PLAINTEXT_REPLY = new Set(["ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_WRONG_VERSION_NUMBER"]);

/** Whether a failed https:// request means nothing speaks TLS at that address. */
export function noTlsThere(err) {
  const e = /** @type {any} */ (err);
  const codes = [e?.cause?.code, ...(e?.cause?.errors ?? []).map((x) => x?.code)].filter(Boolean);
  if (codes.length > 0 && codes.every((code) => code === "ECONNREFUSED")) return true;
  if (codes.some((code) => PLAINTEXT_REPLY.has(code))) return true;
  return /wrong version number|packet length too long/i.test(String(e?.cause?.message ?? ""));
}

/**
 * The probe's request: bounded, and never following a redirect — a followed
 * http→https redirect reads as http:// answering, and would save the
 * cleartext address.
 */
export function probeRequest(timeoutMs) {
  return (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * @param {{ url: string, fetchBase?: string }[]} candidates  in order. `url`
 *   is what the person is told and what gets saved; `fetchBase` is where the
 *   request actually goes when that differs (the tsnet sidecar's loopback).
 * @param {{
 *   request: (url: string) => Promise<{ ok: boolean, status: number, headers: { get: (name: string) => string | null }, json: () => Promise<any> }>,
 *   describe: (err: unknown, url: string) => string,
 * }} io  `request` is `probeRequest` outside tests.
 */
export async function probeCandidates(candidates, { request, describe }) {
  /** @type {{ err: unknown, url: string } | null} */
  let fellBackFrom = null;
  for (const [i, { url, fetchBase = url }] of candidates.entries()) {
    let health;
    try {
      health = await request(`${fetchBase}/health`);
    } catch (err) {
      const next = candidates[i + 1];
      if (next && noTlsThere(err)) {
        fellBackFrom = { err, url };
        continue;
      }
      // Both failed: the https:// reason, the scheme a server is expected to
      // speak, with a note that plain http was tried too.
      if (fellBackFrom) {
        return { ok: false, reason: `${describe(fellBackFrom.err, fellBackFrom.url)} (Tried both https:// and http://.)` };
      }
      return { ok: false, reason: describe(err, url) };
    }
    if (!health.ok) {
      const location = health.status >= 300 && health.status < 400 ? health.headers.get("location") : null;
      const answer = location ? `It redirects to ${location}` : `Server answered ${String(health.status)}`;
      // https:// failing is the news here, not what plain http said after it:
      // a default vhost's 404 would send someone off to fix the wrong thing.
      return {
        ok: false,
        reason: fellBackFrom ? `${describe(fellBackFrom.err, fellBackFrom.url)} (${url} said: ${answer}.)` : answer,
      };
    }
    const found = { ok: true, url, ...(fellBackFrom ? { plainHttp: true } : {}) };
    try {
      const res = await request(`${fetchBase}/v1/cluster`);
      if (!res.ok) return found;
      const body = await res.json();
      return { ...found, cluster: body.cluster, hosts: body.hosts };
    } catch (err) {
      return { ok: false, reason: describe(err, url) };
    }
  }
  return { ok: false, reason: "No URL given" };
}
