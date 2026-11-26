/**
 * `get_location`: the model asks where the person is, and the run's sender's
 * own device answers, as their location-sharing setting allows.
 *
 * The server cannot read a device's position, so even "Always allow" waits
 * for a device: it emits `device.request` (`ask` false: answer without
 * asking), and the device's `device.answer` (ws/run-actions.ts) settles it.
 * Only the sender may answer: it is their position. Whatever happens, the
 * call ends with a result the model can act on, and the local date and time.
 *
 * Built on the approval wait (engine.ts `waitForApproval`): the inference slot
 * is handed back while waiting, a deadline is announced and enforced, and
 * every way out goes through one `settle`.
 */
import { db, eq, sql } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import {
  DEFAULT_LOCATION_SHARING,
  deviceLocalTime,
  isLocationSharing,
  roundCoordinate,
  type DeviceAnswer,
  type DeviceUnavailableReason,
  type LocationOutcome,
  type LocationSharing,
  type ToolDeviceInfo,
} from "@loxaic/types";
import type { RunSlot } from "../../inference/scheduler.ts";
import { RunSlotAbortedError } from "../../inference/scheduler.ts";
import { loadTowns } from "../../geo/cities.ts";
import { nearestTown } from "../../geo/nearest.ts";
import { waitForLocationFollower } from "../device-presence.ts";
import { clearRunDeviceRequest, getRun, setRunDeviceRequest } from "../registry.ts";
import type { StreamProducer } from "../broker.ts";
import { formatLocalTime, storedTimeZone } from "./local-time.ts";
import { jsonbSafe } from "./jsonb-safe.ts";

/** Farther than this from the nearest listed town, the place is not named
 * as that town. */
export const NO_TOWN_NEARBY_KM = 50;

/** How long a device answering on its own ("Always allow") is given. Read at
 * call time, as every env-derived seam is (apps/server/AGENTS.md). */
export function locationSilentTimeoutMs(): number {
  const raw = Number(process.env.LOCATION_SILENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** The person's answer earlier in this run (shared or declined), so a later
 * call does not ask them again while the setting still allows it. Anything
 * else (no device, no answer, unavailable) is asked again: the device may be
 * there now. One per run. */
export interface LocationMemo {
  answered?: { output: string; ok: boolean; device: ToolDeviceInfo };
}

export interface LocationCallContext {
  streamId: string;
  userId: string;
  producer: StreamProducer;
  assistantMsgId: string;
  slot: RunSlot;
  signal: AbortSignal;
  /** The approval window, measured from now: how long a person is given. */
  askDeadline: () => { ms: number; expiresAt: number; basis: "setting" | "adaptive" };
  /** A routine's scheduled run: no device is there to ask. */
  scheduled: boolean;
  memo: LocationMemo;
}

export interface LocationCallResult {
  output: string;
  ok: boolean;
  device: ToolDeviceInfo;
}

/** The setting as it stands now; a failed read is "ask", which only ever
 * asks more. */
async function readSharing(userId: string): Promise<LocationSharing> {
  try {
    const row = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, userId),
      columns: { locationSharing: true },
    });
    return isLocationSharing(row?.locationSharing) ? row.locationSharing : DEFAULT_LOCATION_SHARING;
  } catch (err) {
    console.warn(`could not read the location setting of ${userId}: ${(err as Error).message}`);
    return DEFAULT_LOCATION_SHARING;
  }
}

/** "Always allow" from the prompt: one statement, and a failure never fails
 * the call that carried it. */
async function rememberAlways(userId: string): Promise<void> {
  try {
    await db
      .insert(userPrefs)
      .values({ userId, locationSharing: "always" })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { locationSharing: "always", updatedAt: sql`now()` } });
  } catch (err) {
    console.warn(`could not record "always allow" for ${userId}: ${(err as Error).message}`);
  }
}

type WaitOutcome =
  | { kind: "answered"; answer: DeviceAnswer }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "gone" };

/** Waits for the sender's device, through the registry so the thread list can
 * say the run waits on a person while it asks. */
function waitForDevice(streamId: string, callId: string, signal: AbortSignal, ms: number, ask: boolean): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    const run = getRun(streamId);
    if (!run) {
      resolve({ kind: "gone" });
      return;
    }
    let done = false;
    const settle = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      clearRunDeviceRequest(run, callId);
      resolve(outcome);
    };
    const onAbort = () => { settle({ kind: "aborted" }); };
    const timer = setTimeout(() => { settle({ kind: "timeout" }); }, ms);
    setRunDeviceRequest(run, callId, { ask, resolve: (answer) => { settle({ kind: "answered", answer }); } });
    // No await since the check at the top, so the signal cannot have fired
    // before this listener is attached.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const REASONS: Record<DeviceUnavailableReason, string> = {
  permission_denied: "location permission is turned off for Loxaic on that device",
  insecure_origin: "the browser only shares a location with a site served over https",
  unsupported: "that device has no way to tell its location",
  timeout: "it could not find its position in time",
  error: "it reported an error",
};

const ASK_INSTEAD = "If you need to know where they are, ask them.";

/** The local-time line every result ends with: the device's zone, else the
 * one on record when the server does not know the device's. */
async function localTimeLine(userId: string, tz: string | undefined, now: Date): Promise<string> {
  const fromDevice = tz ? formatLocalTime(now, { tz }) : null;
  const stored = fromDevice ? null : await storedTimeZone(userId);
  const user = fromDevice ?? (stored ? formatLocalTime(now, { tz: stored }) : null);
  if (user) return `Local time: ${user.date}, ${user.time} (${user.zone}).`;
  const server = formatLocalTime(now, deviceLocalTime(now));
  return server ? `Local time on the server (the user's own zone is unknown): ${server.date}, ${server.time} (${server.zone}).` : "";
}

/** What the model is told for a shared position: the nearest town, region
 * and country, never coordinates. City-level is what the person agreed to,
 * and anything the model holds, content it reads can ask it to send on. */
export async function describeShared(lat: number, lon: number): Promise<{ text: string; place?: string }> {
  let town: Awaited<ReturnType<typeof nearestTown>> = null;
  try {
    // Rounded before the lookup, as the device already did.
    town = nearestTown(await loadTowns(), roundCoordinate(lat), roundCoordinate(lon));
  } catch (err) {
    console.warn(`could not read the town list: ${(err as Error).message}`);
  }
  if (!town) return { text: "The user shared their location, but the town it is near could not be named. Ask them where they are if it matters." };
  const place = [town.name, town.region, town.country].filter(Boolean).join(", ");
  if (town.km > NO_TOWN_NEARBY_KM) {
    return {
      text: `Approximate location: no listed town within ${String(NO_TOWN_NEARBY_KM)} km. The nearest is ${place}, about ${String(Math.round(town.km))} km away.`,
    };
  }
  return { text: `Approximate location: ${place} (city-level).`, place };
}

/** The sentence for every way a location call can end without a position. */
export function withoutPosition(outcome: Exclude<LocationOutcome, "shared">, reason?: DeviceUnavailableReason): string {
  switch (outcome) {
    case "declined":
      return `The user chose not to share their location. ${ASK_INSTEAD}`;
    case "off":
      return `The user has turned location sharing off in Loxaic's settings. ${ASK_INSTEAD}`;
    case "unavailable":
      return `The user's device could not give a location: ${REASONS[reason ?? "error"]}. ${ASK_INSTEAD}`;
    case "no_device":
      return `None of the user's devices that can share a location is connected to Loxaic right now. ${ASK_INSTEAD}`;
    case "no_answer":
      return `The user's device did not answer the location request in time. ${ASK_INSTEAD}`;
    case "unattended":
      return `This run was started by a schedule, so there is no device to ask for a location. Use a place named in the task if there is one.`;
  }
}

/**
 * Answers one `get_location` call. Emits its `tool.result` (with `device`) and
 * returns the same, for the caller to store. A stop while waiting throws
 * `RunSlotAbortedError` (from `yieldWhile`, or here), which the tool loop
 * records as a call stopped before it ran.
 */
export async function answerLocationCall(
  ctx: LocationCallContext,
  callId: string,
  args: Record<string, unknown>,
  now: () => Date = () => new Date(),
): Promise<LocationCallResult> {
  const finish = async (
    outcome: LocationOutcome,
    body: string,
    opts: { tz?: string; place?: string } = {},
  ): Promise<LocationCallResult> => {
    const time = await localTimeLine(ctx.userId, opts.tz, now());
    const output = jsonbSafe(time ? `${body}\n${time}` : body);
    const device: ToolDeviceInfo = {
      request: "location",
      outcome,
      ...(opts.place ? { place: opts.place } : {}),
      user_id: ctx.userId,
    };
    const ok = outcome === "shared";
    ctx.producer.emit({
      kind: "tool.result",
      message_id: ctx.assistantMsgId,
      call_id: callId,
      tool: "get_location",
      output,
      ok,
      device,
    });
    const result = { output, ok, device };
    if (outcome === "shared" || outcome === "declined") ctx.memo.answered = result;
    return result;
  };

  if (ctx.scheduled) return finish("unattended", withoutPosition("unattended"));
  // Read on every call, a repeat included: turning sharing off reaches a run
  // already going.
  const sharing = await readSharing(ctx.userId);
  if (sharing === "off") return finish("off", withoutPosition("off"));

  // The person already answered in this run: the same answer, unasked.
  if (ctx.memo.answered) {
    const { output, ok, device } = ctx.memo.answered;
    ctx.producer.emit({ kind: "tool.result", message_id: ctx.assistantMsgId, call_id: callId, tool: "get_location", output, ok, device });
    return { output, ok, device };
  }
  // Only a device following this run can see the request: one on another
  // thread, or none, would leave the run waiting on nobody.
  if (!(await waitForLocationFollower(ctx.userId, ctx.streamId, ctx.signal))) {
    if (ctx.signal.aborted) throw new RunSlotAbortedError();
    return finish("no_device", withoutPosition("no_device"));
  }

  const ask = sharing === "ask";
  const deadline = ask
    ? ctx.askDeadline()
    : { ms: locationSilentTimeoutMs(), expiresAt: Date.now() + locationSilentTimeoutMs(), basis: "setting" as const };
  const reason = typeof args.reason === "string" && args.reason.trim() ? jsonbSafe(args.reason.trim().slice(0, 300)) : undefined;
  ctx.producer.emit({
    kind: "device.request",
    call_id: callId,
    request: "location",
    ask,
    user_id: ctx.userId,
    ...(reason ? { reason } : {}),
    timeout_ms: deadline.ms,
    expires_at: deadline.expiresAt,
    timeout_basis: deadline.basis,
  });
  const waited = await ctx.slot.yieldWhile(() => waitForDevice(ctx.streamId, callId, ctx.signal, deadline.ms, ask));
  if (waited.kind === "aborted" || ctx.signal.aborted) throw new RunSlotAbortedError();
  if (waited.kind !== "answered") return finish("no_answer", withoutPosition("no_answer"));

  const { answer } = waited;
  // "Always allow" counts only from a device that was asking: a device
  // answering on its own is already under it.
  if (answer.always && ask) await rememberAlways(ctx.userId);
  if (answer.outcome === "declined") return finish("declined", withoutPosition("declined"), { tz: answer.tz });
  if (answer.outcome === "unavailable" || !answer.location) {
    return finish("unavailable", withoutPosition("unavailable", answer.reason), { tz: answer.tz });
  }
  const shared = await describeShared(answer.location.lat, answer.location.lon);
  return finish("shared", shared.text, { tz: answer.tz, ...(shared.place ? { place: shared.place } : {}) });
}
