/**
 * The sending device's time zone, carried on every `chat.send`/`agent.send`
 * so the model is told the person's local date and time with their message.
 * Only the zone travels: the time itself is the server's clock when the
 * message arrives, so a device whose clock is wrong cannot mislead the model.
 */
export interface ClientLocalTime {
  /** IANA zone name, e.g. `Australia/Brisbane`. */
  tz?: string;
  /** Minutes east of UTC at the moment of sending (+600 for UTC+10). Used
   * when the zone name is missing or one the server does not know. */
  utc_offset_min?: number;
}

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * A `local_time` as it arrived off the socket, kept only as far as it is
 * well-formed; null when nothing usable is left. An unknown zone name is
 * still kept here (the server's `Intl` decides whether it knows it).
 */
export function normalizeClientLocalTime(value: unknown): ClientLocalTime | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { tz?: unknown; utc_offset_min?: unknown };
  const out: ClientLocalTime = {};
  if (typeof v.tz === "string" && v.tz.length <= 64 && ZONE_NAME.test(v.tz)) out.tz = v.tz;
  if (
    typeof v.utc_offset_min === "number" &&
    Number.isInteger(v.utc_offset_min) &&
    v.utc_offset_min >= -840 &&
    v.utc_offset_min <= 840
  ) {
    out.utc_offset_min = v.utc_offset_min;
  }
  return out.tz !== undefined || out.utc_offset_min !== undefined ? out : null;
}

/** This device's zone, as a client sends it. `now` is for tests. */
export function deviceLocalTime(now: Date = new Date()): ClientLocalTime {
  const out: ClientLocalTime = { utc_offset_min: -now.getTimezoneOffset() };
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) out.tz = tz;
  } catch {
    // A runtime without Intl's zone data: the offset alone still says a lot.
  }
  return out;
}
