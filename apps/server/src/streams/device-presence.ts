/**
 * Which of a person's devices can answer a location request for a given run,
 * per process like the run registry. A socket says what it can do in its
 * `caps` query parameter (`caps=location`); an app too old to answer says
 * nothing. It counts for a run only while it follows that run's stream
 * (ws/delivery.ts), because `device.request` reaches only the sockets
 * following the stream: a phone open on another thread never sees it.
 */
import { DEVICE_CAP_LOCATION } from "@loxaic/types";

/** person → stream → capable sockets following it */
const followers = new Map<string, Map<string, number>>();
const onFollow = new Set<() => void>();

/** The capabilities a socket's URL claims: a comma-separated list. */
export function capsFromQuery(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((c) => c.trim()).filter((c) => c.length > 0 && c.length <= 32);
}

export function canShareLocation(caps: readonly string[]): boolean {
  return caps.includes(DEVICE_CAP_LOCATION);
}

/**
 * Counts one capable socket of `userId` as following `streamId`. Returns the
 * release, to call once when it stops following (or closes); calling it again
 * changes nothing.
 */
export function followStream(userId: string, streamId: string): () => void {
  let streams = followers.get(userId);
  if (!streams) {
    streams = new Map();
    followers.set(userId, streams);
  }
  streams.set(streamId, (streams.get(streamId) ?? 0) + 1);
  for (const notify of [...onFollow]) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const mine = followers.get(userId);
    if (!mine) return;
    const left = (mine.get(streamId) ?? 1) - 1;
    if (left > 0) mine.set(streamId, left);
    else mine.delete(streamId);
    if (mine.size === 0) followers.delete(userId);
  };
}

/** Whether a device of this person's that can share a location follows the run. */
export function hasLocationFollower(userId: string, streamId: string): boolean {
  return (followers.get(userId)?.get(streamId) ?? 0) > 0;
}

/** How long a call waits for the sender's socket to start following its run.
 * The socket that sent subscribes as the send is answered, which a fast model
 * can race. Read at call time, as every env-derived seam is. */
export function followerGraceMs(): number {
  const raw = Number(process.env.LOCATION_FOLLOWER_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}

/** True as soon as a capable device follows the run; false once the grace
 * runs out or the run is stopped. */
export function waitForLocationFollower(
  userId: string,
  streamId: string,
  signal: AbortSignal,
  graceMs: number = followerGraceMs(),
): Promise<boolean> {
  if (hasLocationFollower(userId, streamId)) return Promise.resolve(true);
  if (signal.aborted || graceMs === 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const settle = (found: boolean) => {
      clearTimeout(timer);
      onFollow.delete(check);
      signal.removeEventListener("abort", onAbort);
      resolve(found);
    };
    const check = () => {
      if (hasLocationFollower(userId, streamId)) settle(true);
    };
    const onAbort = () => { settle(false); };
    const timer = setTimeout(() => { settle(false); }, graceMs);
    onFollow.add(check);
    // No await since the check above, so the signal cannot have fired unseen.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
