// The client form's Check: does a Loxaic answer at this address, and which
// of the addresses it could mean is the one that answers?
//
// Kept out of main.js, which cannot be imported under test, because the order
// and the stopping rule are the decisions here: an address typed without a
// scheme is tried as https:// and then http://, and the first one that
// *answers* wins — any status at all, since a 503 is the server talking and
// trying the other scheme would only hide it. Only a failure to connect moves
// on.

/**
 * @param {{ url: string, fetchBase?: string }[]} candidates  in order. `url`
 *   is what the person is told and what gets saved; `fetchBase` is where the
 *   request actually goes when that differs (the tsnet sidecar's loopback).
 * @param {{
 *   request: (url: string) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>,
 *   describe: (err: unknown, url: string) => string,
 * }} io
 */
export async function probeCandidates(candidates, { request, describe }) {
  /** @type {{ err: unknown, url: string } | null} */
  let firstFailure = null;
  for (const { url, fetchBase = url } of candidates) {
    let health;
    try {
      health = await request(`${fetchBase}/health`);
    } catch (err) {
      firstFailure ??= { err, url };
      continue;
    }
    if (!health.ok) return { ok: false, reason: `Server answered ${String(health.status)}` };
    try {
      const res = await request(`${fetchBase}/v1/cluster`);
      if (!res.ok) return { ok: true, url };
      const body = await res.json();
      return { ok: true, url, cluster: body.cluster, hosts: body.hosts };
    } catch (err) {
      return { ok: false, reason: describe(err, url) };
    }
  }
  if (!firstFailure) return { ok: false, reason: "No URL given" };
  // The https failure is the one reported: it is the scheme a server is
  // expected to speak, and its error (a certificate, say) says more than the
  // plain-http attempt that followed it.
  const reason = describe(firstFailure.err, firstFailure.url);
  return { ok: false, reason: candidates.length > 1 ? `${reason} (Tried both https:// and http://.)` : reason };
}
