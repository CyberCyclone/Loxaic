import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ApiError,
  approveTool,
  denyTool,
  getMessages,
  getSubAgents,
  stopStream,
  subscribeStreams,
  type ServerMessage,
  type StreamSnapshot,
  type SubAgentEvent,
} from '@loxaic/api-client';
import { NOT_SENT_RECONNECTING, isOffline } from '@/lib/connection';
import { isServerConvId, reconstructMessages } from '@/lib/streamMessages';
import {
  applySubAgentEvent,
  applySubAgentSnapshot,
  findSubAgent,
  mergeListedSubAgents,
  type SubAgentView,
  type SubAgentsByParent,
} from '@/lib/subAgents';
import {
  EMPTY_TRANSCRIPT,
  applyChildEnd,
  applyChildEvent,
  applyChildSync,
  historyAsked,
  withChildHistory,
  type ChildTranscript,
} from '@/lib/subAgentTranscript';

type Sync = Extract<ServerMessage, { type: 'stream.sync' }>;
type StreamEvent = Extract<ServerMessage, { type: 'stream.event' }>;
type StreamEnd = Extract<ServerMessage, { type: 'stream.end' }>;

/**
 * The sub-agent side of a session hook: every thread's children, and the
 * transcript of whichever one's panel is open.
 *
 * It lives inside the session hooks (`useAgentSession`, and `useChatSession`
 * for a routine's chats) because it shares their socket, and because a child's
 * stream arrives on that socket as ordinary `stream.*` messages for a
 * conversation id the hook has never heard of. The hook asks `isChild` first
 * and hands those here; applied as a thread's, they would be dropped at best
 * and at worst clear the parent's pending send, toast a child's error on the
 * parent's screen and refetch the model list once per child.
 *
 * Two feeds, deliberately different:
 *
 * - **What a card shows** comes from the *parent's* stream (`subagent.*`
 *   events and the snapshot's `subagents`), which the hook is already
 *   subscribed to — so a thread with four children running costs nothing extra.
 * - **A transcript** comes from the child's own stream, subscribed only when
 *   its panel is opened. Four streams of text deltas on one socket for cards
 *   that show none of them is what the delivery layer's backpressure exists to
 *   drop.
 *
 * Every function returned is stable for the life of the hook: the session
 * hooks call them from inside the effect that owns the socket, which must not
 * re-run because a callback changed.
 */
export function useSubAgentState(opts: {
  wsRef: RefObject<WebSocket | null>;
  /** The session hook's per-stream cursors. Shared, so its gap detection
   * covers a child's stream exactly as it covers a thread's. */
  cursorsRef: RefObject<Partial<Record<string, number>>>;
  showToast: (text: string, ms?: number) => void;
}) {
  const { wsRef, cursorsRef } = opts;
  const showToastRef = useRef(opts.showToast);
  showToastRef.current = opts.showToast;

  const [byParent, setByParentState] = useState<SubAgentsByParent>({});
  const byParentRef = useRef<SubAgentsByParent>({});
  const setByParent = useCallback((updater: (prev: SubAgentsByParent) => SubAgentsByParent) => {
    // The ref moves at once, not on React's flush: `isChild` is asked about
    // the very next socket message, which can arrive before a render.
    const next = updater(byParentRef.current);
    if (next === byParentRef.current) return;
    byParentRef.current = next;
    setByParentState(next);
  }, []);

  const [transcripts, setTranscripts] = useState<Partial<Record<string, ChildTranscript>>>({});
  const updateTranscript = useCallback((childId: string, updater: (t: ChildTranscript) => ChildTranscript) => {
    setTranscripts((prev) => {
      const have = prev[childId] ?? EMPTY_TRANSCRIPT;
      const next = updater(have);
      return next === have && childId in prev ? prev : { ...prev, [childId]: next };
    });
  }, []);

  const [openId, setOpenIdState] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  /** Children whose Stop has been sent and not yet seen to land. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());

  // Every child conversation this hook has been told of or opened. A child's
  // stream keeps arriving after its panel closes (there is no unsubscribe),
  // so "known" outlives "open".
  const knownChildrenRef = useRef(new Set<string>());
  // Children subscribed on the current socket, and those whose stored history
  // has been asked for. A new socket starts with nothing subscribed.
  const subscribedRef = useRef(new Set<string>());
  const historyAskedRef = useRef(new Set<string>());
  const listedRef = useRef(new Set<string>());
  // Threads whose listing could not be asked for. Not "none": their cards and
  // list say so, and they are asked again when there is reason to think the
  // server will answer.
  const [listFailed, setListFailed] = useState<ReadonlySet<string>>(() => new Set());
  const listFailedRef = useRef<ReadonlySet<string>>(listFailed);
  const markListFailed = useCallback((parentConvId: string, failed: boolean) => {
    if (listFailedRef.current.has(parentConvId) === failed) return;
    const next = new Set(listFailedRef.current);
    if (failed) next.add(parentConvId);
    else next.delete(parentConvId);
    listFailedRef.current = next;
    setListFailed(next);
  }, []);

  const noteChildren = useCallback((state: SubAgentsByParent) => {
    for (const list of Object.values(state)) for (const s of list ?? []) knownChildrenRef.current.add(s.conversation_id);
  }, []);

  const isChild = useCallback((convId: string): boolean => knownChildrenRef.current.has(convId), []);

  // ── The parent's stream ─────────────────────────────────

  const onParentEvent = useCallback((parentConvId: string, event: SubAgentEvent) => {
    setByParent((prev) => {
      const next = applySubAgentEvent(prev, parentConvId, event, Date.now());
      noteChildren(next);
      return next;
    });
    if (event.kind === 'subagent.ended') {
      setStopping((prev) => {
        if (!prev.has(event.conversation_id)) return prev;
        const next = new Set(prev);
        next.delete(event.conversation_id);
        return next;
      });
    }
  }, [noteChildren, setByParent]);

  const onParentSync = useCallback((parentConvId: string, snapshot: StreamSnapshot, serverNow?: number) => {
    if (!snapshot.subagents?.length) return;
    setByParent((prev) => {
      const next = applySubAgentSnapshot(prev, parentConvId, snapshot.subagents, Date.now(), serverNow);
      noteChildren(next);
      return next;
    });
    const ended = new Set(snapshot.subagents.filter((s) => s.status !== 'running').map((s) => s.conversation_id));
    setStopping((prev) => {
      if (![...prev].some((id) => ended.has(id))) return prev;
      return new Set([...prev].filter((id) => !ended.has(id)));
    });
  }, [noteChildren, setByParent]);

  /**
   * The stored listing, once per thread per session — what brings the cards
   * and the list back after a reload.
   *
   * Only an answer settles it. A 404 is one (an older server, or a thread that
   * is gone): "none it can tell us of", not asked again. Anything else — the
   * server unreachable, slow at launch, a 5xx — is "could not ask": the thread
   * is forgotten so the next call asks again, and remembered as failed so the
   * list can say so rather than "No sub-agents yet". Swallowed like a 404, a
   * reload during a blip lost a thread's finished sub-agents for the session.
   */
  const loadFor = useCallback((parentConvId: string) => {
    if (!isServerConvId(parentConvId) || listedRef.current.has(parentConvId)) return;
    listedRef.current.add(parentConvId);
    getSubAgents(parentConvId)
      .then(({ subagents, serverNow }) => {
        markListFailed(parentConvId, false);
        setByParent((prev) => {
          const next = mergeListedSubAgents(prev, parentConvId, subagents, Date.now(), serverNow);
          noteChildren(next);
          return next;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          markListFailed(parentConvId, false);
          return;
        }
        listedRef.current.delete(parentConvId);
        markListFailed(parentConvId, true);
      });
  }, [markListFailed, noteChildren, setByParent]);

  // ── A child's own stream ────────────────────────────────

  const onChildSync = useCallback((event: Sync) => {
    // Synchronously, like the session hook does for a thread: the next event
    // in this tick is compared against it.
    if (event.status === 'active') cursorsRef.current[event.stream_id] = event.seq;
    updateTranscript(event.conversation_id, (t) => applyChildSync(t, event));
  }, [cursorsRef, updateTranscript]);

  const onChildEvent = useCallback((event: StreamEvent) => {
    updateTranscript(event.conversation_id, (t) => applyChildEvent(t, event));
  }, [updateTranscript]);

  const onChildEnd = useCallback((event: StreamEnd) => {
    updateTranscript(event.conversation_id, (t) => applyChildEnd(t, event));
  }, [updateTranscript]);

  const subscribe = useCallback((childId: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN || subscribedRef.current.has(childId)) return;
    const view = findSubAgent(byParentRef.current, childId);
    const cursor = view ? cursorsRef.current[view.stream_id] : undefined;
    if (subscribeStreams(ws, childId, view && cursor !== undefined ? { [view.stream_id]: cursor } : undefined)) {
      subscribedRef.current.add(childId);
    }
  }, [cursorsRef, wsRef]);

  /** A new socket: nothing is subscribed on it yet. Only the open panel's
   * child is worth subscribing again. A socket that opened is also the server
   * answering, so the listings that could not be asked for are asked again. */
  const resubscribe = useCallback(() => {
    subscribedRef.current.clear();
    if (openIdRef.current) subscribe(openIdRef.current);
    for (const parentConvId of listFailedRef.current) loadFor(parentConvId);
  }, [loadFor, subscribe]);

  // ── What a person does ──────────────────────────────────

  const open = useCallback((childId: string) => {
    knownChildrenRef.current.add(childId);
    openIdRef.current = childId;
    setOpenIdState(childId);
    if (historyAskedRef.current.has(childId)) {
      subscribe(childId);
      return;
    }
    historyAskedRef.current.add(childId);
    // History first, then the live stream — the order a thread opens in, so a
    // snapshot is applied in front of stored rows it may be newer than.
    getMessages(childId)
      .then((page) => { updateTranscript(childId, (t) => withChildHistory(t, reconstructMessages(page.messages))); })
      .catch(() => { updateTranscript(childId, historyAsked); })
      // Only while its panel is still the open one. There is no unsubscribe,
      // so a child subscribed after its sheet closed streamed every text
      // delta onto this socket for the rest of the session, for nobody.
      .finally(() => { if (openIdRef.current === childId) subscribe(childId); });
  }, [subscribe, updateTranscript]);

  const close = useCallback(() => {
    openIdRef.current = null;
    setOpenIdState(null);
  }, []);

  /** Stops one sub-agent. Its parent carries on, told that it was stopped.
   * Returns whether the stop went out. */
  const stop = useCallback((childId: string): boolean => {
    const view = findSubAgent(byParentRef.current, childId);
    const ws = wsRef.current;
    if (view?.status !== 'running') return false;
    if (isOffline() || !ws || !stopStream(ws, view.stream_id)) {
      showToastRef.current(NOT_SENT_RECONNECTING, 4000);
      return false;
    }
    setStopping((prev) => new Set(prev).add(childId));
    return true;
  }, [wsRef]);

  /**
   * Answers a child's approval. The prompt closes only once the answer is on
   * the wire — the rule the parent's own approval follows (#231) — and the
   * answer names the child's run, since the parent may hold the same call id.
   * `always` is "Allow always", as for the thread's own approval.
   */
  const answer = useCallback((childId: string, approved: boolean, always = false): boolean => {
    const view = findSubAgent(byParentRef.current, childId);
    const approval = view?.approval;
    const ws = wsRef.current;
    if (!approval) return false;
    const sent =
      !isOffline() &&
      !!ws &&
      (approved
        ? approveTool(ws, approval.callId, approval.streamId, always)
        : denyTool(ws, approval.callId, approval.streamId));
    if (!sent) {
      showToastRef.current(NOT_SENT_RECONNECTING, 4000);
      return false;
    }
    setByParent((prev) => {
      const next: SubAgentsByParent = {};
      for (const [parentId, list] of Object.entries(prev)) {
        next[parentId] = list?.map((s): SubAgentView => {
          if (s.conversation_id !== childId) return s;
          const { approval: _approval, pending_approval: _pending, ...rest } = s;
          return { ...rest, state: 'running' };
        });
      }
      return next;
    });
    return true;
  }, [setByParent, wsRef]);

  return useMemo(
    () => ({
      byParent,
      transcripts,
      openId,
      stopping,
      listFailed,
      isChild,
      onParentEvent,
      onParentSync,
      onChildSync,
      onChildEvent,
      onChildEnd,
      loadFor,
      resubscribe,
      open,
      close,
      stop,
      answer,
    }),
    [answer, byParent, close, isChild, listFailed, loadFor, onChildEnd, onChildEvent, onChildSync, onParentEvent, onParentSync, open, openId, resubscribe, stop, stopping, transcripts],
  );
}

export type SubAgentController = ReturnType<typeof useSubAgentState>;
