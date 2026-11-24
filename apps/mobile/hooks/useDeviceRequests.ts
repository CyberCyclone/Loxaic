import { useCallback, useEffect, useRef, useState } from 'react';
import { answerDeviceRequest, type StreamEventKind, type StreamSnapshot } from '@loxaic/api-client';
import { NOT_SENT_RECONNECTING, isOffline } from '@/lib/connection';
import { deviceZone, getDevicePosition } from '@/lib/deviceLocation';
import {
  answerFor,
  deviceRequestKey,
  locationAction,
  toPendingDeviceRequest,
  type LocationChoice,
  type PendingDeviceRequest,
} from '@/lib/deviceRequest';

type ByConv = Partial<Record<string, PendingDeviceRequest>>;

/**
 * Sends on the socket open now, waiting a little for one: finding a position
 * can send a phone's app to the background (an OS prompt), and coming back
 * replaces the socket, so the one in hand when the person tapped may be
 * closing by the time there is an answer to send.
 */
async function sendWhenOpen(current: () => WebSocket | null, send: (ws: WebSocket) => boolean, waitMs = 10_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const ws = current();
    if (ws?.readyState === WebSocket.OPEN) return send(ws);
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const without = (prev: ByConv, convId: string): ByConv =>
  convId in prev ? Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId)) : prev;

/**
 * Location requests (`get_location`) waiting on this person's device, per
 * conversation. The server offers the tool to chat runs only, so the chat
 * session hook feeds it the stream; it keeps what waits, answers a request the person chose "Always
 * allow" for without asking, and sends the person's choice at the prompt.
 *
 * An answer names the run it arrived on: call ids repeat across runs.
 */
export function useDeviceRequests(input: {
  wsRef: React.RefObject<WebSocket | null>;
  me: string | null | undefined;
  showToast: (message: string, durationMs?: number) => void;
}) {
  const { wsRef, me, showToast } = input;
  const [pendingByConv, setPendingByConv] = useState<ByConv>({});
  const pendingRef = useRef<ByConv>({});
  pendingRef.current = pendingByConv;
  // Sent from here, so a resync does not show the prompt again; and being
  // answered (the position is a few seconds away), so neither a second press
  // nor the silent answer below starts another. Read before every update,
  // never out of one.
  const answeredRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Set<string>());
  const [, setAnsweredVersion] = useState(0);

  /** A `stream.sync` for the run this conversation is tracking. */
  const onSync = useCallback((convId: string, streamId: string, snapshot: StreamSnapshot, serverNow: number | undefined, arrivedAt: number) => {
    const waiting = snapshot.pending_device_request;
    setPendingByConv((prev) =>
      waiting ? { ...prev, [convId]: toPendingDeviceRequest(waiting, arrivedAt, streamId, serverNow) } : without(prev, convId),
    );
  }, []);

  /** A live event of that run. */
  const onEvent = useCallback((convId: string, streamId: string, event: StreamEventKind, arrivedAt: number) => {
    if (event.kind === 'device.request') {
      setPendingByConv((prev) => ({ ...prev, [convId]: toPendingDeviceRequest(event, arrivedAt, streamId) }));
    } else if (event.kind === 'tool.result') {
      setPendingByConv((prev) => {
        const p = prev[convId];
        return p?.callId === event.call_id && p.streamId === streamId ? without(prev, convId) : prev;
      });
    }
  }, []);

  /** The run ended: whatever it waited on can no longer be answered. */
  const onStreamEnd = useCallback((convId: string) => {
    setPendingByConv((prev) => without(prev, convId));
  }, []);

  /** A rewind removed these runs. */
  const onRewound = useCallback((convId: string, removedStreams: ReadonlySet<string>) => {
    setPendingByConv((prev) => {
      const p = prev[convId];
      return p && removedStreams.has(p.streamId) ? without(prev, convId) : prev;
    });
  }, []);

  /**
   * Sends this device's answer for a conversation's request. `deny` sends at
   * once; the others first ask the OS for the position (its own prompt, the
   * first time). Returns once sent, or once it could not be.
   */
  const answer = useCallback(
    async (convId: string, choice: LocationChoice): Promise<void> => {
      const pending = pendingRef.current[convId];
      if (!pending) return;
      const key = deviceRequestKey(pending);
      if (answeredRef.current.has(key) || inFlightRef.current.has(key)) return;
      if (isOffline()) {
        showToast(NOT_SENT_RECONNECTING, 4000);
        return;
      }
      inFlightRef.current.add(key);
      try {
        const position = choice === 'deny' ? null : await getDevicePosition();
        const reply = answerFor(choice, position, deviceZone());
        const sent = await sendWhenOpen(() => wsRef.current, (ws) => answerDeviceRequest(ws, pending.streamId, pending.callId, reply));
        if (!sent) {
          // Not on the wire: the prompt stays so it can be answered again.
          showToast(NOT_SENT_RECONNECTING, 4000);
          return;
        }
        answeredRef.current.add(key);
        setAnsweredVersion((v) => v + 1);
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [wsRef, showToast],
  );

  // "Always allow": answered without asking, by whichever of the person's
  // devices gets there first.
  useEffect(() => {
    for (const [convId, pending] of Object.entries(pendingByConv)) {
      if (locationAction({ pending, me, answered: answeredRef.current }) === 'answerSilently') void answer(convId, 'once');
    }
  }, [pendingByConv, me, answer]);

  /** What this device shows for a conversation's request. */
  const actionFor = useCallback(
    (convId: string | null) => locationAction({ pending: convId ? pendingByConv[convId] : null, me, answered: answeredRef.current }),
    [pendingByConv, me],
  );

  return { pendingByConv, onSync, onEvent, onStreamEnd, onRewound, answer, actionFor };
}
