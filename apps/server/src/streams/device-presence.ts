/**
 * Which people have a device connected that can answer a location request,
 * per process like the run registry. A socket says what it can do in its
 * `caps` query parameter (`caps=location`); an app too old to answer says
 * nothing, so a `get_location` call never waits on a device that cannot reply.
 */
import { DEVICE_CAP_LOCATION } from "@loxaic/types";

const locationSockets = new Map<string, number>();

/** The capabilities a socket's URL claims: a comma-separated list. */
export function capsFromQuery(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((c) => c.trim()).filter((c) => c.length > 0 && c.length <= 32);
}

/**
 * Counts this socket for its person. Returns the release, to call once when
 * the socket closes; calling it again changes nothing.
 */
export function registerDeviceSocket(userId: string, caps: readonly string[]): () => void {
  if (!caps.includes(DEVICE_CAP_LOCATION)) return () => undefined;
  locationSockets.set(userId, (locationSockets.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (locationSockets.get(userId) ?? 1) - 1;
    if (left > 0) locationSockets.set(userId, left);
    else locationSockets.delete(userId);
  };
}

/** Whether any device of this person's that can share a location is connected. */
export function hasLocationDevice(userId: string): boolean {
  return (locationSockets.get(userId) ?? 0) > 0;
}
