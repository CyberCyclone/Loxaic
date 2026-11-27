import type { DeviceAnswer, DeviceUnavailableReason, WaitDeadlineFields } from '@loxaic/api-client';
import { localDeadline, type WaitDeadline } from './pendingWaits';

/**
 * A run waiting on the sender's device for its location (`get_location`,
 * apps/server/src/streams/runs/location.ts). Only `userId` — the run's
 * sender — answers; anyone else following the run is told it waits on them.
 */
export interface PendingDeviceRequest {
  callId: string;
  /** The run that asked: the answer has to name it. */
  streamId: string;
  /** True: ask the person. False: they chose "Always allow"; answer alone. */
  ask: boolean;
  userId: string;
  /** Why the model wants it, in its words. */
  reason?: string;
  deadline?: WaitDeadline;
}

/** `serverNow` present means "from a snapshot", as for an approval. */
export function toPendingDeviceRequest(
  src: WaitDeadlineFields & { call_id: string; ask: boolean; user_id: string; reason?: string },
  now: number,
  streamId: string,
  serverNow?: number,
): PendingDeviceRequest {
  const deadline = localDeadline(src, now, serverNow);
  return {
    callId: src.call_id,
    streamId,
    ask: src.ask,
    userId: src.user_id,
    ...(src.reason ? { reason: src.reason } : {}),
    ...(deadline ? { deadline } : {}),
  };
}

/** React key for the prompt on screen: one instance per request. */
export function deviceRequestKey(pending: PendingDeviceRequest): string {
  return `${pending.streamId}:${pending.callId}`;
}

/**
 * What this device does about a request:
 * - `prompt`: ask the person ("Share your location?");
 * - `answerSilently`: they chose "Always allow" — answer without asking;
 * - `waitingForOther`: someone else's run waits on that person's device;
 * - `none`: nothing waits, this device already answered, or who is signed in
 *   is not known yet (a cold start) — it may be the sender.
 */
export type LocationAction = 'none' | 'prompt' | 'answerSilently' | 'waitingForOther';

export function locationAction(input: {
  pending: PendingDeviceRequest | null | undefined;
  /** The signed-in user; null or undefined while not known. */
  me: string | null | undefined;
  /** Requests this device has answered (`deviceRequestKey`). */
  answered: { has(key: string): boolean };
}): LocationAction {
  const { pending, me } = input;
  if (!pending || !me) return 'none';
  if (pending.userId !== me) return 'waitingForOther';
  if (input.answered.has(deviceRequestKey(pending))) return 'none';
  return pending.ask ? 'prompt' : 'answerSilently';
}

/**
 * The answers to stop counting as given once `opened` replaces the socket:
 * every one that went out on another socket. A frame sent just before a socket
 * dies is gone (a phone's OS prompt or position fix can background the app,
 * which replaces the socket), and nothing says whether it arrived: a reconnect
 * whose cursor is current gets no snapshot, only what happens next. So the
 * prompt, or the silent answer, comes back; if the answer did arrive, its
 * `tool.result` follows on the new socket and clears it, and a second answer
 * is ignored by the server.
 */
export function answersSentElsewhere(answered: ReadonlyMap<string, object>, opened: object): string[] {
  return [...answered].filter(([, sentOn]) => sentOn !== opened).map(([key]) => key);
}

/** The person's choice at the prompt, or the silent answer of "Always". */
export type LocationChoice = 'once' | 'always' | 'deny';

/**
 * Why a device could not give a position, from what the platform threw. The
 * model is told, so it can ask in a way the person can act on.
 */
export function reasonFromError(err: unknown, ctx: { secureContext: boolean; supported: boolean }): DeviceUnavailableReason {
  if (!ctx.supported) return 'unsupported';
  if (!ctx.secureContext) return 'insecure_origin';
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  // Web GeolocationPositionError: 1 permission, 2 unavailable, 3 timeout.
  if (code === 1 || /denied|permission/i.test(message)) return 'permission_denied';
  if (code === 3 || /time(d)? ?out/i.test(message)) return 'timeout';
  if (code === 2 || /unavailable|disabled|services are/i.test(message)) return 'unsupported';
  return 'error';
}

/** City-level: two decimal places, about a kilometre. The server rounds again. */
export function roundForSending(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

/**
 * The answer to send for a choice, given what getting the position gave.
 * "Always" is sent only with a share or an unavailable device, never with a
 * refusal (the server ignores it there too).
 */
export function answerFor(
  choice: LocationChoice,
  position: { ok: true; lat: number; lon: number } | { ok: false; reason: DeviceUnavailableReason } | null,
  tz: string | undefined,
): DeviceAnswer {
  const zone = tz ? { tz } : {};
  if (choice === 'deny') return { outcome: 'declined', ...zone };
  const always = choice === 'always' ? { always: true as const } : {};
  if (position?.ok) return { outcome: 'shared', location: roundForSending(position.lat, position.lon), ...zone, ...always };
  return { outcome: 'unavailable', reason: position?.reason ?? 'error', ...zone, ...always };
}

/**
 * Sends on the socket open now, waiting a little for one: finding a position
 * can send a phone's app to the background (an OS prompt), and coming back
 * replaces the socket, so the one in hand when the person tapped may be
 * closing by the time there is an answer to send. False when none opened.
 */
export async function sendWhenOpen(
  current: () => { readyState: number } | null,
  send: (ws: WebSocket) => boolean,
  opts: { waitMs?: number; stepMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const { waitMs = 10_000, stepMs = 250 } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + waitMs;
  for (;;) {
    const ws = current();
    // 1 is WebSocket.OPEN, written out so this runs where WebSocket is not defined.
    if (ws?.readyState === 1) return send(ws as WebSocket);
    if (now() >= until) return false;
    await sleep(stepMs);
  }
}
