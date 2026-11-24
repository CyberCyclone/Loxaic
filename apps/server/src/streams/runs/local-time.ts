/**
 * The date and time a message was sent, in the sender's time zone, told to
 * the model ahead of the message (a `local_time` block on the user row; see
 * `noticesOf` in engine.ts). The clock is the server's, read when the row is
 * written; the zone is the device's (`ClientLocalTime`) or, for a routine,
 * the owner's last known one. The text is built once and stored, so a replay
 * sends exactly what the live request did whatever the zone data says later.
 */
import { db, eq, sql } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import { deviceLocalTime, type ClientLocalTime, type ContentBlock } from "@loxaic/types";

export const LOCAL_TIME_OPEN = "<local-time>";
export const LOCAL_TIME_CLOSE = "</local-time>";

export interface FormattedLocalTime {
  /** ISO 8601 to the minute, with the zone's offset: `2026-11-24T09:15+10:00`. */
  at: string;
  /** The zone name, when it was one `Intl` knows. */
  tz?: string;
  /** `Tuesday 24 November 2026` */
  date: string;
  /** `09:15` */
  time: string;
  /** `Australia/Brisbane, UTC+10:00`, or `UTC+10:00` with no zone name. */
  zone: string;
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const PARTS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

function partsOf(now: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { ...PARTS, timeZone }).formatToParts(now)) out[p.type] = p.value;
  return out;
}

/** Minutes east of UTC that `timeZone` is at `now`. Throws for a zone `Intl`
 * does not know. */
function zoneOffset(now: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT+10:00", "GMT-03:30", or plain "GMT" for UTC itself.
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? "");
  if (!m) throw new RangeError(`unexpected offset ${String(name)}`);
  if (!m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

function numeric(now: Date, offsetMin: number): { y: string; mo: string; d: string; h: string; mi: string } {
  const shifted = new Date(now.getTime() + offsetMin * 60_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    y: String(shifted.getUTCFullYear()),
    mo: two(shifted.getUTCMonth() + 1),
    d: two(shifted.getUTCDate()),
    h: two(shifted.getUTCHours()),
    mi: two(shifted.getUTCMinutes()),
  };
}

/**
 * `now` as the sender's wall clock shows it. The zone name wins when `Intl`
 * knows it; otherwise the offset alone; null when neither is usable.
 */
export function formatLocalTime(now: Date, zone: ClientLocalTime): FormattedLocalTime | null {
  let tz: string | undefined;
  let offset: number | undefined;
  if (zone.tz) {
    try {
      offset = zoneOffset(now, zone.tz);
      tz = zone.tz;
    } catch {
      // Not a zone this server's Intl knows: fall back to the offset.
    }
  }
  offset ??= zone.utc_offset_min;
  if (offset === undefined) return null;
  const n = numeric(now, offset);
  // Weekday and month names from Intl, read at UTC on the shifted instant, so
  // they agree with the numeric date whichever way the zone was resolved.
  const words = partsOf(new Date(Date.UTC(Number(n.y), Number(n.mo) - 1, Number(n.d), 12)), "UTC");
  return {
    at: `${n.y}-${n.mo}-${n.d}T${n.h}:${n.mi}${offsetLabel(offset)}`,
    ...(tz ? { tz } : {}),
    date: `${words.weekday} ${String(Number(n.d))} ${words.month} ${n.y}`,
    time: `${n.h}:${n.mi}`,
    zone: tz ? `${tz}, UTC${offsetLabel(offset)}` : `UTC${offsetLabel(offset)}`,
  };
}

/**
 * The block for a user row, or null when the zone is unknown (an older client
 * sends none, and its message then carries no time, as before).
 *
 * `whose`: `user` for the sender's own zone, `server` when a routine's owner
 * has never sent from a device and the server's zone stands in.
 */
export function localTimeBlock(
  now: Date,
  zone: ClientLocalTime | null,
  source: "device" | "schedule",
  whose: "user" | "server" = "user",
): Extract<ContentBlock, { kind: "local_time" }> | null {
  if (!zone) return null;
  const f = formatLocalTime(now, zone);
  if (!f) return null;
  const who = source === "schedule" ? "A schedule sent this message" : "The user sent this message";
  const clock = whose === "server" ? "the server's local time" : source === "schedule" ? "the user's local time" : "their local time";
  return {
    kind: "local_time",
    at: f.at,
    ...(f.tz ? { tz: f.tz } : {}),
    source,
    text: `${LOCAL_TIME_OPEN}${who} on ${f.date} at ${f.time}, ${clock} (${f.zone}).${LOCAL_TIME_CLOSE}`,
  };
}

/** What a starter is told about when the message was sent: the device's zone
 * (`chat.send`'s `local_time`), `"schedule"` for a routine's run, or nothing
 * (an older client), in which case the message carries no time. */
export type SentFrom = ClientLocalTime | "schedule" | null | undefined;

/**
 * The block for the user row a starter is about to write. A routine's run is
 * dated in its owner's last known zone, else the server's.
 */
export async function sentAtBlock(
  userId: string,
  from: SentFrom,
  now: Date = new Date(),
): Promise<Extract<ContentBlock, { kind: "local_time" }> | null> {
  if (!from) return null;
  if (from !== "schedule") return localTimeBlock(now, from, "device");
  const stored = await storedTimeZone(userId);
  return (
    (stored ? localTimeBlock(now, { tz: stored }, "schedule") : null) ??
    localTimeBlock(now, deviceLocalTime(now), "schedule", "server")
  );
}

async function storedTimeZone(userId: string): Promise<string | null> {
  try {
    const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId), columns: { timeZone: true } });
    return row?.timeZone ?? null;
  } catch (err) {
    console.warn(`could not read the time zone of ${userId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Keeps the zone a person sends from, for their routines. One statement that
 * writes only when the zone changed; only a zone this server knows is kept.
 * Swallows its own failures: the time zone is a convenience, the send is not.
 */
export async function rememberTimeZone(userId: string, from: SentFrom, now: Date = new Date()): Promise<void> {
  if (!from || from === "schedule") return;
  const tz = formatLocalTime(now, from)?.tz;
  if (!tz) return;
  try {
    await db
      .insert(userPrefs)
      .values({ userId, timeZone: tz })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { timeZone: tz },
        setWhere: sql`${userPrefs.timeZone} IS DISTINCT FROM ${tz}`,
      });
  } catch (err) {
    console.warn(`could not record the time zone of ${userId}: ${(err as Error).message}`);
  }
}
