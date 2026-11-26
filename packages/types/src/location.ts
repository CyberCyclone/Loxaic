/**
 * The location tool (`get_location`): the model asks where the person is, and
 * the person's own device answers, as their location-sharing setting allows.
 * The server cannot read a device's position, so every answer is the device's
 * (`device.request` out, `device.answer` back); the server names the nearest
 * town from its own offline list and tells the model the local time too.
 */

/** Off: the model is told sharing is off. Ask: the device shows "Share your
 * location?". Always: the device answers without asking. */
export type LocationSharing = "off" | "ask" | "always";

export const LOCATION_SHARING_VALUES: readonly LocationSharing[] = ["off", "ask", "always"];

export const DEFAULT_LOCATION_SHARING: LocationSharing = "ask";

export function isLocationSharing(value: unknown): value is LocationSharing {
  return typeof value === "string" && (LOCATION_SHARING_VALUES as readonly string[]).includes(value);
}

export const LOCATION_TOOL_NAME = "get_location";

/** What a socket says it can do, in its `caps` query parameter: this one can
 * answer a location request. */
export const DEVICE_CAP_LOCATION = "location";

/** Why a device could not give a position. */
export type DeviceUnavailableReason = "permission_denied" | "insecure_origin" | "unsupported" | "timeout" | "error";

const UNAVAILABLE_REASONS: readonly DeviceUnavailableReason[] = [
  "permission_denied",
  "insecure_origin",
  "unsupported",
  "timeout",
  "error",
];

/** A device's answer to a location request (`device.answer`, less its address). */
export interface DeviceAnswer {
  outcome: "shared" | "declined" | "unavailable";
  /** City-level: the device rounds to two decimal places (about 1 km), and
   * the server rounds again. Only with `shared`. */
  location?: { lat: number; lon: number };
  /** Only with `unavailable`. */
  reason?: DeviceUnavailableReason;
  /** The device's IANA zone, for the local time the model is told. */
  tz?: string;
  /** "Always allow": share now and stop asking. Never with `declined`. */
  always?: boolean;
}

/** Coordinates kept to two decimal places: about a kilometre. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * A `device.answer` as it arrived off the socket, kept only as far as it is
 * well-formed; null when the outcome itself is not. A position goes only with
 * `shared` (a `shared` without one is not an answer), a reason only with
 * `unavailable`, and "always" never with `declined`.
 */
export function normalizeDeviceAnswer(value: unknown): DeviceAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const outcome = v.outcome;
  if (outcome !== "shared" && outcome !== "declined" && outcome !== "unavailable") return null;
  const out: DeviceAnswer = { outcome };
  if (outcome === "shared") {
    const loc = v.location as { lat?: unknown; lon?: unknown } | null | undefined;
    const lat = loc?.lat;
    const lon = loc?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    out.location = { lat: roundCoordinate(lat), lon: roundCoordinate(lon) };
  }
  if (outcome === "unavailable") {
    out.reason = (UNAVAILABLE_REASONS as readonly unknown[]).includes(v.reason) ? (v.reason as DeviceUnavailableReason) : "error";
  }
  if (typeof v.tz === "string" && v.tz.length <= 64 && ZONE_NAME.test(v.tz)) out.tz = v.tz;
  if (v.always === true && outcome !== "declined") out.always = true;
  return out;
}

/** How a location call ended, on its `tool.result` and stored result. */
export type LocationOutcome = "shared" | "declined" | "off" | "unavailable" | "no_device" | "no_answer" | "unattended";

/** Set on a `get_location` call's result, for a client to draw its card. */
export interface ToolDeviceInfo {
  request: "location";
  outcome: LocationOutcome;
  /** "Brisbane, Queensland, Australia", with `shared`. */
  place?: string;
  /** Whose device was asked: the run's sender. Anyone else reading the
   * conversation gets the result through `locationResultFor`. */
  user_id?: string;
}

/** What someone other than the sender reads in place of a location result. */
export const LOCATION_SHARED_ELSEWHERE = "Shared their location.";
export const LOCATION_NOT_SHARED_ELSEWHERE = "Did not share their location.";

/**
 * A `get_location` result (a stored block, a live event or a snapshot's call)
 * as `reader` may see it. The person whose device answered sees it all;
 * anyone else in the conversation (a share member, an admin) sees only whether
 * a location was shared: no place, no coordinates, no local time. A result
 * with no `user_id` is treated as someone else's. Anything else is returned
 * as it was.
 */
export function locationResultFor<T extends { output?: string; device?: ToolDeviceInfo }>(item: T, reader: string): T {
  const d = item.device;
  if (!d || d.user_id === reader) return item;
  return {
    ...item,
    output: d.outcome === "shared" ? LOCATION_SHARED_ELSEWHERE : LOCATION_NOT_SHARED_ELSEWHERE,
    device: { request: d.request, outcome: d.outcome, ...(d.user_id ? { user_id: d.user_id } : {}) },
  };
}
