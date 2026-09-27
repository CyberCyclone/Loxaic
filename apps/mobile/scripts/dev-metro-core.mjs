/**
 * What `pnpm dev` does about Metro, decided from what is on the port now.
 *
 * `pnpm dev` starts the API server, Metro and the desktop app together, and the
 * desktop's development build loads its screens from Metro. Most of the time
 * a developer already has a Metro of their own on :8081 (`pnpm --filter
 * @loxaic/mobile web`, or `start` for a phone), and a second one would only
 * fight it for the port — Expo asks to move to another port, which nothing
 * reading turbo's output can answer, and the desktop would still be pointed at
 * the first. So an existing Metro is used as it is, and one is started only
 * when the port is free.
 */

/** Metro answers GET /status with this line once it is serving. */
export const METRO_STATUS = 'packager-status:running';

/**
 * @param {{ kind: 'metro' } | { kind: 'other', status: number } | { kind: 'free' }} probe
 *   what answered on the port: Metro's own status line, something else, or nothing
 * @returns {{ action: 'reuse' | 'start' | 'refuse', message: string }}
 */
export function decide(probe, port) {
  switch (probe.kind) {
    case 'metro':
      return {
        action: 'reuse',
        message: `Metro is already running on :${String(port)}; using it. (Stop it and re-run pnpm dev to have this one start its own.)`,
      };
    case 'other':
      return {
        action: 'refuse',
        message:
          `Something that is not Metro is listening on :${String(port)} (it answered /status with ${String(probe.status)}). ` +
          'The desktop app loads its screens from Metro on that port, so it will wait on its "Waiting for Metro" page until the port is free and Metro is started.',
      };
    default:
      return { action: 'start', message: `Starting Metro on :${String(port)}.` };
  }
}

/** What answers on `url` right now. */
export async function probePort(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url}/status`, { signal: AbortSignal.timeout(1500) });
    const body = await res.text();
    return res.ok && body.includes(METRO_STATUS) ? { kind: 'metro' } : { kind: 'other', status: res.status };
  } catch {
    return { kind: 'free' };
  }
}
