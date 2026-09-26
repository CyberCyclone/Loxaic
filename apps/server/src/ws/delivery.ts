import type { ServerMessage, StreamSnapshot, StreamStatus } from "@loxaic/types";
import { assertConversationAccess } from "../streams/authz.ts";
import { getStreamBroker } from "../streams/index.ts";
import type { StreamRecord } from "../streams/types.ts";
import { watchConversation } from "../streams/watchers.ts";

const BACKPRESSURE_BYTES = 512 * 1024;

/**
 * Shared by both WS handlers: turns "subscribe to a conversation" into a
 * catch-up snapshot plus a live tap per active stream, and turns a
 * producer's `end()` into a `stream.end` delivered to every subscriber —
 * including devices that never sent the original `*.send`.
 */
export function createDelivery(
  userId: string,
  send: (msg: ServerMessage) => void,
  getBufferedAmount: () => number,
) {
  const subs = new Map<string, { unsubRecord: () => void; unsubEnd: () => void }>();
  const convWatches = new Map<string, () => void>();
  /** Finished runs this socket has already been sent a snapshot of. Re-sending
   * those is pure waste — they cannot change — and doing it on every
   * subscribe is actively harmful: a long finished run's snapshot is large,
   * and repeated copies saturate the socket, trip backpressure, and drop the
   * live events the client actually needs. */
  const syncedFinished = new Set<string>();

  /**
   * How a subscribe catches the client up before the live tap takes over:
   * - `catchUp`: a snapshot of the whole run when the client is behind.
   * - `tapOnly`: the client already has every event (#231). Read only what
   *   came after its cursor, normally nothing, and fold nothing: a run parked
   *   on an approval after a long turn holds thousands of records, and this
   *   runs on every app switch.
   * - `forceSync`: a snapshot even when the cursor is not behind — for a run
   *   that finished while the client was caught up (see handleSubscribe).
   */
  type CatchUp = "catchUp" | "tapOnly" | "forceSync";

  async function subscribeToStream(
    streamId: string,
    conversationId: string,
    cursor: number,
    mode: CatchUp = "catchUp",
  ): Promise<void> {
    if (subs.has(streamId)) return;
    // Reserve the slot synchronously, before any `await` below — otherwise
    // two callers racing to subscribe to the same stream (e.g. this
    // socket's own `autoSubscribe` after a send, firing concurrently with
    // its standing conv-watch reacting to that very same new run) would
    // both pass the guard above and each register a live tap, double-
    // delivering every event. The placeholder is replaced with the real
    // unsubscribers once they exist; nothing reads `subs` before then.
    subs.set(streamId, { unsubRecord: () => undefined, unsubEnd: () => undefined });
    const broker = getStreamBroker();

    // Race-free handoff: tap live records BEFORE reading catch-up, buffer
    // anything that arrives mid-read, then drop what the sync snapshot
    // already covers and flush the rest in order. Getting this backwards
    // (read-then-tap) would drop events that land in the gap between the
    // read finishing and the tap attaching.
    let currentSeq = 0;
    let syncSent = false;
    const pending: StreamRecord[] = [];

    const forward = (record: StreamRecord) => {
      currentSeq = record.seq;
      // Backpressure: never queue unbounded data for a slow client. Simply
      // dropping the send is safe — the client's gap-healing (a `seq` that
      // doesn't immediately follow its cursor) makes it re-subscribe and
      // resync from a fresh snapshot on its own.
      if (getBufferedAmount() > BACKPRESSURE_BYTES) return;
      send({ type: "stream.event", stream_id: streamId, conversation_id: conversationId, seq: record.seq, event: record.event });
    };

    const unsubRecord = broker.onRecord(streamId, (record) => {
      if (!syncSent) {
        pending.push(record);
        return;
      }
      forward(record);
    });

    let records = await broker.readFrom(streamId, mode === "tapOnly" ? cursor : 0);
    const meta = await broker.getMeta(streamId);
    const status: StreamStatus = meta?.status ?? "active";

    if (mode === "tapOnly" && status === "active") {
      // Nothing to fold: whatever landed after the cursor goes out as events,
      // which follow the cursor contiguously, so the client takes them as-is.
      currentSeq = cursor;
      syncSent = true;
      for (const record of [...records, ...pending]) {
        if (record.seq <= currentSeq) continue;
        forward(record);
      }
      const unsubEndLive = broker.onEnd(streamId, (info) => {
        send({
          type: "stream.end",
          stream_id: streamId,
          conversation_id: conversationId,
          seq: currentSeq,
          status: info.status,
          usage: info.usage,
          error: info.error,
        });
        unsubscribeStream(streamId);
      });
      subs.set(streamId, { unsubRecord, unsubEnd: unsubEndLive });
      return;
    }
    // A tap-only subscribe whose run ended in the meantime has to say so, and
    // only a snapshot carries the status: fall through to one.
    const forceSync = mode === "forceSync" || mode === "tapOnly";
    if (mode === "tapOnly") records = await broker.readFrom(streamId, 0);
    const folded = broker.foldSnapshot(records);
    currentSeq = records.length ? records[records.length - 1].seq : 0;
    // A finished run holds no questions. Both `pending_approval` and
    // `pending_checkin` describe a run parked on a person, and neither can be
    // answered once the stream has ended — so advertising one to a client
    // catching up is offering a button that does nothing.
    //
    // Stripped here rather than in `foldSnapshot`, which is pure over the
    // record log and cannot see the terminal status: `producer.end` writes no
    // record, it only finalizes the meta. This is the one place the snapshot
    // and the status are both in hand.
    //
    // Found by stopping a run parked at a check-in: the abort emits no
    // `steps.decision` — nobody decided — so nothing in the log ever cleared
    // the question, and the next resync put the banner back on a run that had
    // already ended. An approval survives this by accident, because its abort
    // path records a `tool.result` that the fold clears on.
    const snapshot: StreamSnapshot =
      status === "active"
        ? folded
        : (({ pending_approval: _a, pending_checkin: _c, ...rest }) => rest)(folded);

    if (currentSeq > cursor || forceSync) {
      send({
        type: "stream.sync",
        stream_id: streamId,
        conversation_id: conversationId,
        seq: currentSeq,
        status,
        snapshot,
        // A pending wait's `expires_at` is on the server's clock. With this a
        // client can count down on its own clock without trusting the two to
        // agree — a phone a minute fast would otherwise show a minute too few.
        server_now: Date.now(),
      });
    }
    syncSent = true;
    for (const record of pending) {
      if (record.seq <= currentSeq) continue;
      forward(record);
    }

    const unsubEnd = broker.onEnd(streamId, (info) => {
      send({
        type: "stream.end",
        stream_id: streamId,
        conversation_id: conversationId,
        seq: currentSeq,
        status: info.status,
        usage: info.usage,
        error: info.error,
      });
      unsubscribeStream(streamId);
    });

    subs.set(streamId, { unsubRecord, unsubEnd });

    // Already finished by the time we caught up — no live tap needed.
    if (status !== "active") unsubscribeStream(streamId);
  }

  function unsubscribeStream(streamId: string): void {
    const s = subs.get(streamId);
    if (!s) return;
    s.unsubRecord();
    s.unsubEnd();
    subs.delete(streamId);
  }

  /** `stream.subscribe` handler. Throws NotFoundError (via
   * assertConversationAccess) for both "doesn't exist" and "not yours" —
   * callers must render both identically.
   *
   * Looks at the conversation's last few runs regardless of active/finished
   * status, not just currently-active ones: single-flight-per-conversation
   * means there's never more than one truly active run, so this one code
   * path covers both "still streaming, catch me up live" (an active run the
   * client's cursor is behind on) and "finished while I was disconnected"
   * (a just-completed run the client never got the tail of) — the latter
   * would otherwise need a separate REST refresh, which risks clobbering
   * live-accumulated text the moment it raced a still-active stream.
   *
   * Also registers a standing watch for brand-new runs on this conversation
   * (kept until the socket closes) — without it, a second device already
   * viewing this conversation would only ever learn about a run *another*
   * device started by reconnecting or re-subscribing; live multi-device
   * fan-out for a run that didn't exist yet at subscribe time needs this,
   * since there's no stream id to tap until the run is created. */
  async function handleSubscribe(conversationId: string, cursors: Record<string, number> = {}): Promise<void> {
    await assertConversationAccess(userId, conversationId);
    const broker = getStreamBroker();
    const recentRunIds = (await broker.driver.listConvStreams(conversationId)).slice(-3);
    const metas = (await Promise.all(recentRunIds.map((id) => broker.getMeta(id))))
      .filter((m): m is NonNullable<typeof m> => !!m);

    send({
      type: "conv.streams",
      conversation_id: conversationId,
      streams: metas.map((m) => ({ stream_id: m.streamId, status: m.status, last_seq: m.lastSeq })),
    });

    for (const meta of metas) {
      const cursor = cursors[meta.streamId] ?? 0;
      if (meta.lastSeq <= cursor) {
        // Nothing to catch up on, but a live run still needs a tap on *this*
        // socket, which may be a new one. A run parked on an approval emits
        // nothing while it waits, so a client reconnecting then is always
        // exactly caught up, and skipping it here left the new socket deaf to
        // the rest of the run (#231). A no-op on a socket that already has it.
        if (meta.status === "active") {
          await subscribeToStream(meta.streamId, conversationId, cursor, "tapOnly");
          continue;
        }
        // The same hole for a run that finished while the client was caught
        // up. `producer.end` writes no record, so the cursor still equals
        // lastSeq, and the `stream.end` that told the client was sent live —
        // lost with the socket a resume replaces. Without this the client
        // shows a finished run as streaming, Stop enabled, until a reload.
        // Only for the run the client says it is following (its cursor names
        // it), and once per socket: a snapshot carries the status, and both
        // hooks clear a run only when the snapshot is for the run they track.
        if (meta.streamId in cursors && !syncedFinished.has(meta.streamId)) {
          syncedFinished.add(meta.streamId);
          await subscribeToStream(meta.streamId, conversationId, cursor, "forceSync");
        }
        continue;
      }

      if (meta.status !== "active") {
        // Finished run: worth one snapshot (that's the "it finished while I
        // was disconnected" case), but only ever one per socket.
        if (syncedFinished.has(meta.streamId)) continue;
        syncedFinished.add(meta.streamId);
        await subscribeToStream(meta.streamId, conversationId, cursor);
        continue;
      }

      // Active run. An explicit subscribe means the client is telling us it's
      // behind — most often because it detected a gap in `seq` and wants to
      // be put right. Simply attaching a tap is not enough here: if one
      // already exists, `subscribeToStream` would no-op and the client would
      // never receive the catch-up it asked for, leaving its cursor stuck so
      // that *every* later event reads as another gap. That turns one dropped
      // event into an endless resubscribe storm which starves the socket and
      // stalls rendering until the run ends. Tearing the tap down first
      // forces a genuine resync down the same race-free path.
      unsubscribeStream(meta.streamId);
      await subscribeToStream(meta.streamId, conversationId, cursor);
    }

    if (!convWatches.has(conversationId)) {
      const unwatch = watchConversation(conversationId, (streamId) => {
        subscribeToStream(streamId, conversationId, 0).catch(() => undefined);
      });
      convWatches.set(conversationId, unwatch);
    }
  }

  /** Auto-subscribes the socket that just started a run to its own stream,
   * without a separate round-trip. */
  function autoSubscribe(streamId: string, conversationId: string): Promise<void> {
    return subscribeToStream(streamId, conversationId, 0);
  }

  function close(): void {
    for (const s of subs.values()) {
      s.unsubRecord();
      s.unsubEnd();
    }
    subs.clear();
    for (const unwatch of convWatches.values()) unwatch();
    convWatches.clear();
  }

  return { handleSubscribe, autoSubscribe, close };
}
