import { endStaleSubAgents, type RunActivity, type ServerMessage, type StreamSnapshot, type StreamStatus } from "@loxaic/types";
import { assertConversationAccess, filterAccessible } from "../streams/authz.ts";
import { getStreamBroker } from "../streams/index.ts";
import type { StreamRecord } from "../streams/types.ts";
import { getRunByConversation, listBusyRuns, runActivityOf } from "../streams/registry.ts";
import { watchConversation, watchConversationEvents, watchRunActivity } from "../streams/watchers.ts";

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
          ...(info.errorCode ? { error_code: info.errorCode } : {}),
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
    //
    // The same holds for its sub-agents. A run waits for its children before
    // it ends and stopping it stops them, so one still marked running in a
    // finished run's log is one whose end was never written — and shown as
    // running it would offer a Stop, and an approval, that reach nothing.
    const snapshot: StreamSnapshot =
      status === "active"
        ? folded
        : (({ pending_approval: _a, pending_checkin: _c, subagents, ...rest }) => ({
            ...rest,
            ...(subagents ? { subagents: endStaleSubAgents(subagents, meta?.updatedAt ?? Date.now()) } : {}),
          }))(folded);

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
        // When the run began, on the same clock: a device that learns of a
        // run late (it started it elsewhere, or reconnected) times it from its
        // real start rather than from the moment it heard.
        ...(meta ? { started_at: meta.createdAt } : {}),
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
        ...(info.errorCode ? { error_code: info.errorCode } : {}),
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

    watch(conversationId);
  }

  /** Registers the standing watch for new runs on a conversation, once per
   * socket. */
  function watch(conversationId: string): void {
    if (convWatches.has(conversationId)) return;
    const unwatch = watchConversation(conversationId, (streamId) => {
      // A snapshot even at seq 0: a run the server started itself (an
      // automatic compaction, a routine) is announced before anything is
      // stored, and without a snapshot this device applied its events to
      // the thread but never counted the run as going — no Stop button, a
      // composer that looked free, and a summary card that switched to the
      // typing indicator whenever a later resync finally said so.
      //
      // Re-authorized per run, because a watch outlives the command that
      // installed it: a share revoked since must not go on receiving every
      // later run on the conversation, a compaction's summary of the whole
      // thread included. Every command re-authorizes; so does this.
      assertConversationAccess(userId, conversationId)
        .then(() => subscribeToStream(streamId, conversationId, 0, "forceSync"))
        .catch(() => undefined);
    });
    // Messages removed from its end (a rewind, a retry): passed on so this
    // device drops them, re-authorized for the same reason as a run.
    const unwatchEvents = watchConversationEvents(conversationId, (event) => {
      assertConversationAccess(userId, conversationId)
        .then(() => {
          for (const streamId of event.removed_stream_ids) {
            unsubscribeStream(streamId);
            syncedFinished.delete(streamId);
          }
          send(event);
        })
        .catch(() => undefined);
    });
    convWatches.set(conversationId, () => {
      unwatch();
      unwatchEvents();
    });
  }

  /** Auto-subscribes the socket that just started a run to its own stream,
   * without a separate round-trip — and watches the conversation, as a
   * subscribe would. The sender is looking at it, and the next run on it may
   * well be one the server starts: the automatic compaction after this very
   * turn. Without the watch, a conversation created on this socket heard of
   * nothing it did not send until the socket was replaced. The caller has
   * already authorized the send. */
  function autoSubscribe(streamId: string, conversationId: string): Promise<void> {
    watch(conversationId);
    return subscribeToStream(streamId, conversationId, 0);
  }

  /* ── The thread list's liveness watch (#282) ─────────────────── */

  /** Conversations this socket asked to watch for runs it is not following.
   * A replacement set — the client re-sends its whole visible list whenever
   * it changes. */
  let runWatch = new Set<string>();
  /** What this socket was last told per watched conversation, so a
   * re-announcement of the same state (a second approval while already
   * awaiting one) sends nothing. `null` is "no run", recorded as "". */
  const lastRunNotice = new Map<string, string>();
  let unwatchActivity: (() => void) | null = null;

  /** A watch is only as large as a list. The client's own cap is the list's
   * (50 rows today); this is the server's boundary against a client that
   * watches everything it has ever seen. */
  const MAX_WATCH = 100;
  const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function noticeFor(conversationId: string): Extract<ServerMessage, { type: "conversation.run" }> | null {
    const handle = getRunByConversation(conversationId);
    if (!handle) return { type: "conversation.run", conversation_id: conversationId, run: null };
    const run = runActivityOf(handle);
    return {
      type: "conversation.run",
      conversation_id: conversationId,
      run,
      ...(run === "queued" && handle.queuePosition ? { queue_position: handle.queuePosition } : {}),
    };
  }

  /** Send a watched conversation's current liveness, once, if it differs from
   * what this socket was last told. Re-authorized per event, as the new-run
   * watch does: a share revoked since must stop hearing about this thread. */
  function sendRunNotice(conversationId: string): void {
    const notice = noticeFor(conversationId);
    if (!notice) return;
    const key = notice.run === null ? "" : notice.run + (notice.queue_position ? `:${String(notice.queue_position)}` : "");
    if (lastRunNotice.get(conversationId) === key) return;
    assertConversationAccess(userId, conversationId)
      .then(() => {
        if (!runWatch.has(conversationId)) return;
        // Re-read after the await: the state at the moment of the event may
        // have moved on while authz ran, and a stale figure arriving late
        // would overwrite the fresh one. What we send must be what the
        // registry says now.
        const fresh = noticeFor(conversationId);
        if (!fresh) return;
        const freshKey = fresh.run === null ? "" : fresh.run + (fresh.queue_position ? `:${String(fresh.queue_position)}` : "");
        if (lastRunNotice.get(conversationId) === freshKey) return;
        lastRunNotice.set(conversationId, freshKey);
        send(fresh);
      })
      .catch(() => undefined);
  }

  function ensureActivityTap(): void {
    if (unwatchActivity) return;
    unwatchActivity = watchRunActivity((conversationId) => {
      if (runWatch.has(conversationId)) sendRunNotice(conversationId);
    });
  }

  /**
   * `conversations.watch`. Installs the set synchronously (an announcement
   * during the authz await below must not fall on deaf ears), authorizes the
   * batch with two queries rather than one round trip per row, and answers
   * with the current activity of every watched conversation that has a run
   * going. Ids the caller cannot see are dropped from the watch entirely —
   * they hear nothing, forever, exactly as `stream.stop` no-ops.
   */
  async function handleConversationsWatch(ids: unknown): Promise<void> {
    if (!Array.isArray(ids)) return;
    const next = new Set<string>();
    for (const id of ids) {
      // A claim off a socket: only UUID-shaped ids are kept, so a client's
      // optimistic placeholder never reaches a Postgres query.
      if (typeof id === "string" && CONVERSATION_ID_RE.test(id)) next.add(id);
      if (next.size >= MAX_WATCH) break;
    }
    // Install before awaiting: a run that starts mid-authz is announced to
    // the tap, which re-reads the registry after authz and sends its truth.
    runWatch = next;
    // A conversation that left the set needs no "null": the client's own map
    // drops it when its list changes, which is what changed the set.
    for (const id of lastRunNotice.keys()) {
      if (!next.has(id)) lastRunNotice.delete(id);
    }
    ensureActivityTap();
    if (next.size === 0) return;
    let allowed: Set<string>;
    try {
      allowed = await filterAccessible(userId, next);
    } catch {
      return;
    }
    // The set may have been replaced by a newer watch while we awaited; the
    // newer call owns the state, and this reply describes the old set.
    if (runWatch !== next) return;
    for (const id of next) {
      if (!allowed.has(id)) {
        runWatch.delete(id);
        continue;
      }
      if (!getRunByConversation(id)) continue;
      // The initial reply names only the conversations with a run going —
      // a busy row's truth. An idle row gets nothing: absence already says
      // it, and fifty `run: null` messages per list refresh (or per app
      // switch, which resends the watch) is traffic that carries no news.
      // The transition to null comes from the tap, once this socket has been
      // told the row was busy.
      //
      // Sent regardless of the dedup map: a row that left the list (its
      // notice dropped) and came back busy must be re-told, and replacement
      // semantics make the duplicate harmless.
      const notice = noticeFor(id);
      if (!notice || notice.run === null) continue;
      lastRunNotice.set(id, notice.run + (notice.queue_position ? `:${String(notice.queue_position)}` : ""));
      send(notice);
    }
  }

  function close(): void {
    for (const s of subs.values()) {
      s.unsubRecord();
      s.unsubEnd();
    }
    subs.clear();
    for (const unwatch of convWatches.values()) unwatch();
    convWatches.clear();
    if (unwatchActivity) {
      unwatchActivity();
      unwatchActivity = null;
    }
  }

  return { handleSubscribe, autoSubscribe, handleConversationsWatch, close };
}
