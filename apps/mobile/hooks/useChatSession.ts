import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createChatSocket,
  sendChatMessage,
  sendCommand,
  subscribeStreams,
  stopStream,
  approveTool,
  denyTool,
  sendStepsDecision,
  deleteConversation,
  getConversations,
  getMessages,
  isUnreachableError,
  getMcpServers,
  getPrefs,
  updateConversation,
  updateMcpServer,
  updatePrefs,
  type ServerMessage,
  type AttachmentRef,
  type StepsDecision,
  type Conversation as ApiConversation,
} from '@loxaic/api-client';
import { useEndpoint } from './useEndpoint';
import { isOffline, setConnectionState } from '@/lib/connection';
import { lastUserId, readCachedConversations, removeCachedConversation, writeCachedConversation, writeCachedList } from '@/lib/message-cache';
import { useSession } from '@/lib/session';
import type { Conversation } from '@/lib/types';
import { applyEventToMsgs, applySnapshotToMsgs, isServerConvId, reconstructMessages } from '@/lib/streamMessages';
import { useToastHelper } from './useToastHelper';
import type { PendingCheckin } from './useAgentSession';

export interface PendingApproval { callId: string; tool: string; args: Record<string, unknown> }

/** Imported from the agent hook rather than redeclared: both surfaces render
 * the same banner, so a second definition is a second thing to keep in step. */
export type { PendingCheckin };

/** MCP tools arrive namespaced as `server__tool`; builtins never contain
 * `__` — mirrors ToolCallCard/PermissionBar's splitMcpTool. */
function splitMcpTool(name: string): { slug: string; remoteName: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { slug: name.slice(0, idx), remoteName: name.slice(idx + 2) };
}

/** Per-conversation in-flight stream state — keyed by conversation id so
 * switching threads mid-response can never show one conversation's stop
 * button, elapsed timer, or model label on another. Preserved across a
 * socket reconnect (not cleared on close): the seq cursor (tracked in a ref,
 * not here) is what makes resuming
 * exact, and clearing on every drop would also reset the elapsed timer for
 * no reason. It's only ever cleared by an authoritative terminal status —
 * `stream.sync.status !== "active"` (already finished by the time we
 * caught up) or a live `stream.end`. */
interface StreamState {
  streamId: string;
  loadingModel: boolean;
  /** Place in the inference queue while this run waits for a slot, else null.
   * Per-conversation like the rest of this state, so switching threads shows
   * the right one's status rather than the last event's. */
  queuePosition: number | null;
  responseStartedAt: number;
  model: string;
}

/** Minimum spacing between resync requests for the same stream. */
const RESYNC_COOLDOWN_MS = 500;

/**
 * Which set of conversations this session is over.
 *
 * Chat passes nothing and behaves exactly as it always has. A routine passes
 * its own scope: the same socket, the same event handling, the same streaming
 * and approval state — over its own list, with the things that only make sense
 * for the Chat surface switched off.
 *
 * A parameter rather than a second copy of the hook, because what a routine
 * chat needs is nine tenths of this file: ~300 lines of WebSocket event
 * handling, resync cursors, per-conversation approval and check-in state. The
 * codebase already has one copy of that in `useAgentSession`, and a third
 * would be a third place to fix the next stream bug.
 */
export interface ChatScope {
  /** The conversations this session lists. */
  list: () => Promise<Conversation[]>;
  /** Which `kind` belongs here — the cache and the list are filtered by it. */
  kind: Conversation['kind'];
  /**
   * False for a scope whose conversations are made by something other than
   * typing into the composer. A routine chat exists because a run created it;
   * a send with nothing open would otherwise silently open a *chat*
   * conversation on the routines screen.
   */
  allowCreate: boolean;
  /**
   * False for a scope with no offline cache. A routine's chats are not read
   * back offline: they would take eviction slots from the user's own threads,
   * and the chat surface's own list write prunes anything it does not
   * recognise.
   */
  cache: boolean;
  /**
   * True to send `stream.subscribe` when a conversation is opened.
   *
   * The hook otherwise subscribes only on socket open and on a seq gap, which
   * is enough for Chat, where a run always starts from this client. A routine
   * run starts on the server, at 6am, so opening its chat is the first this
   * client hears of it — without this the transcript sits there static while
   * the run streams on.
   */
  subscribeOnSelect: boolean;
  /** Opened instead of the newest, when present and still in the list. */
  initialActiveId?: string | null;
}

/** The Chat surface's own scope: every conversation of kind `chat`, cached,
 * created implicitly by sending. Module-level so its identity is stable across
 * renders — it is in effect dependencies. */
const CHAT_SCOPE: ChatScope = {
  list: async () => {
    const convs = await getConversations();
    // Each surface shows only its own kind: general chats here, coding
    // sessions under Agent, routine runs under Routines. See #117 — and note
    // the server now excludes routine conversations from this endpoint
    // outright, so this filter is the second of two.
    //
    // An empty `kind` is a chat: the column postdates some rows.
    return convs
      .filter((c) => (c.kind || 'chat') === 'chat')
      .map(toConversation);
  },
  kind: 'chat',
  allowCreate: true,
  cache: true,
  subscribeOnSelect: false,
};

/** An API row as the surfaces hold it. Shared so a scope's own `list` does not
 * have to restate the mapping. */
export function toConversation(c: ApiConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    kind: (c.kind || 'chat') as Conversation['kind'],
    time: 'recent',
    model: c.modelPref?.model ?? '',
    location: 'server' as const,
    msgs: [],
    updatedAt: c.updatedAt,
    role: c.role ?? 'owner',
  };
}

export function useChatSession(token: string | null, onStreamEnd?: () => void, scope: ChatScope = CHAT_SCOPE) {
  // Re-run the socket effect when the API endpoint changes, so a desktop
  // mode switch or a Settings change reconnects to the new host instead of
  // silently holding the old one until the app restarts.
  const endpoint = useEndpoint();
  const { user } = useSession();

  /** Where this user's cache lives. Null until both parts are known — caching
   * under a guessed scope would leak one user's threads to the next. */
  const cacheScope = useCallback(() => {
    if (!endpoint) return null;
    // Falls back to the remembered id: offline, the session bootstrap can't
    // reach the server, so `user` is null — and that is precisely when the
    // cache needs to be readable.
    const userId = user?.id ?? lastUserId(endpoint);
    if (!userId) return null;
    return { endpoint, userId };
  }, [endpoint, user?.id]);

  // The history loader is a stable callback (it must not re-create per render
  // — `loadedConvIdsRef` dedupes against it), so it reads the scope through a
  // ref rather than closing over one that would go stale.
  const cacheScopeRef = useRef(cacheScope());
  /** Conversation ids whose messages came from the cache rather than a live
   * run, and so must yield to the server's history when it arrives. */
  const fromCacheRef = useRef(new Set<string>());
  useEffect(() => { cacheScopeRef.current = cacheScope(); }, [cacheScope]);
  // Empty, not demo fixtures. Seeding them meant a signed-in user always saw
  // fake threads ("Debug WebSocket reconnect" and friends) mixed into their
  // real ones, permanently — and made an unreachable server indistinguishable
  // from a populated account.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /** Whether the list has come back at least once — the difference between
   * "this routine has never run" and "we haven't asked yet", which are
   * different screens. */
  const [listLoaded, setListLoaded] = useState(false);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  // Read through a ref by the stable callbacks below (`setActiveId` must not
  // re-create per render — `loadedConvIdsRef` dedupes against its identity).
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** The list as of the last render, for callbacks that must *decide* from it.
   * An updater passed to `setConversations` is not a place to read a result
   * back out of — see handleDelete. */
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [streamingByConv, setStreamingByConvState] = useState<Partial<Record<string, StreamState>>>({});
  // Keyed by conversation, unlike the agent surface's flat pendingApproval
  // (GitHub issue #1) — a background chat send that hits an approval must
  // never show its dialog over whatever conversation the user has switched
  // to, and switching back to it should find the dialog still there.
  const [pendingApprovalByConv, setPendingApprovalByConv] = useState<Partial<Record<string, PendingApproval>>>({});
  /** Keyed for the same reason as the approvals above: a check-in belongs to
   * its conversation, not to whatever is on screen when it arrives. */
  const [pendingCheckinByConv, setPendingCheckinByConv] = useState<Partial<Record<string, PendingCheckin>>>({});
  /** Which conversation the user asked to stop — see useAgentSession for why
   * this is keyed by id and why it exists at all (#113). */
  const [stoppingConvId, setStoppingConvId] = useState<string | null>(null);
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  /** What each stream's failed message said — see useAgentSession for why a
   * run-level error is only toasted when it differs. */
  const lastMessageErrorRef = useRef(new Map<string, string>());
  // Held in a ref rather than read from the WS effect's closure: the effect
  // only re-runs on [token], and adding an inline callback to its deps would
  // tear down and rebuild the socket on every render of the parent screen.
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;
  // A ref alongside the state: the WS effect's closure is only re-created on
  // [token], so reading `activeId` state directly inside it would be stale
  // the moment the user switches threads mid-stream. Route deltas by this
  // instead (falls back to the event's own conversation_id when unset).
  const activeIdRef = useRef<string | null>(null);
  const streamingByConvRef = useRef<Partial<Record<string, StreamState>>>({});
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);
  // The optimistic user bubble pushed by handleSend has no server id yet;
  // the server's own `message.start` for that same message arrives moments
  // later with a real one. Without renaming the optimistic entry in place,
  // `message.start`'s id-based dedup never matches it and appends a second,
  // duplicate bubble for every single send.
  const pendingUserMsgIdRef = useRef<string | null>(null);
  /** Last time we asked the server to resync a given stream — see the gap
   * handler below for why this needs a floor. */
  const lastResyncAtRef = useRef<Record<string, number>>({});
  /**
   * Last applied seq per stream, tracked here rather than in React state.
   * This has to update the instant an event is handled: several deltas
   * routinely arrive within a single tick, and a cursor that only advances
   * when React flushes would still read as stale for the rest of that batch,
   * making every event after the first look like a gap and get dropped.
   */
  const cursorsRef = useRef<Partial<Record<string, number>>>({});

  const setStreamingByConv = useCallback(
    (
      updater: (
        prev: Partial<Record<string, StreamState>>,
      ) => Partial<Record<string, StreamState>>,
    ) => {
      setStreamingByConvState((prev) => {
        const next = updater(prev);
        streamingByConvRef.current = next;
        return next;
      });
    },
    [],
  );

  const clearStream = useCallback(
    (id: string) => {
      setStreamingByConv((prev) => {
        if (!(id in prev)) return prev;
        return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
      });
      setStoppingConvId((prev) => (prev === id ? null : prev));
    },
    [setStreamingByConv],
  );

  // Threads whose history has been fetched (or is in flight). The mount-time
  // load below only ever covered the single most recent thread, so switching
  // to any older one left it permanently empty — nothing else backfills it
  // (stream.subscribe replays live runs, not cold history).
  const loadedConvIdsRef = useRef<Set<string>>(new Set());

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
    // Optimistic local ids (created before the server assigns a real
    // one — see handleSend below) aren't fetchable: the server has never
    // heard of them, and the id gets swapped for the real one as soon as
    // turn.started arrives, no fetch required.
    if (!id || !isServerConvId(id)) return;
    // A run this client did not start — a routine firing on a schedule — is
    // already streaming by the time the screen opens it. The socket-open
    // resubscribe cannot cover that: nothing was open then. Sent *after* the
    // history fetch settles, because a snapshot landing first fills the thread
    // and the history fill below only applies to an empty one, so the older
    // messages would be dropped.
    const subscribeIfWanted = () => {
      if (!scopeRef.current.subscribeOnSelect) return;
      const ws = wsRef.current;
      if (ws) subscribeStreams(ws, id);
    };
    if (loadedConvIdsRef.current.has(id)) {
      subscribeIfWanted();
      return;
    }
    loadedConvIdsRef.current.add(id);
    getMessages(id)
      .then(({ messages: rows }) => {
        setConnectionState('online');
        const msgs = reconstructMessages(rows);
        if (msgs.length === 0) return;
        // Only fill a thread that is still empty: one already streaming (or
        // already populated by this same fetch) must not be clobbered.
        // The empty-check predates the cache, when a thread always started
        // empty and this fetch was the only thing that filled it. A thread
        // populated *from the cache* must still be overwritten by the server's
        // history — otherwise messages added from another device never appear
        // and the stale copy is written straight back to the cache. Only a
        // thread populated by a live run is protected.
        const fromCache = fromCacheRef.current.has(id);
        fromCacheRef.current.delete(id);
        setConversations((prev) => {
          const next = prev.map((c) =>
            c.id === id && (c.msgs.length === 0 || fromCache) ? { ...c, msgs } : c,
          );
          // Cache the thread as it now stands, so it can be read back offline.
          const scope = scopeRef.current.cache ? cacheScopeRef.current : null;
          const conv = next.find((c) => c.id === id);
          if (scope && conv) writeCachedConversation(scope.endpoint, scope.userId, conv);
          return next;
        });
        subscribeIfWanted();
      })
      .catch((err: unknown) => {
        loadedConvIdsRef.current.delete(id);
        // Still subscribe: a failed history read says nothing about whether a
        // run is going right now, and the live stream is the more urgent half.
        subscribeIfWanted();
        // Only a request that never got an answer means the host is gone. A
        // 404 for a deleted row or a 500 for one bad query is a *reachable*
        // server saying no; treating those as offline locked the user out of
        // sending on a healthy host, with nothing to recover it.
        if (isUnreachableError(err)) setConnectionState('offline');
      });
  }, []);

  /** Renames the pending optimistic user bubble (if any) to its real
   * server-assigned id, in place — call this before any id-based upsert of
   * that same message, so it updates rather than duplicates. */
  const promotePendingUserMsg = useCallback((convId: string, realId: string) => {
    const pending = pendingUserMsgIdRef.current;
    if (!pending) return;
    pendingUserMsgIdRef.current = null;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId ? { ...c, msgs: c.msgs.map((m) => (m.id === pending ? { ...m, id: realId } : m)) } : c,
      ),
    );
  }, []);

  /**
   * Re-read the scope's list from the server.
   *
   * Extracted from the mount effect so a routine screen can call it after
   * starting a run — that run's chat did not exist a moment ago, and nothing
   * else would bring it into the list.
   */
  const refreshList = useCallback(async () => {
    const active = scopeRef.current;
    try {
      const apiConversations = await active.list();
      setConnectionState('online');
      // Built outside the updater so the *merged* list — cached messages
      // kept — is what reaches the cache. Passing `apiConversations` (every
      // entry `msgs: []`) wrote an empty message list over every cached
      // thread on each online start, defeating the cache it was feeding.
      let merged: Conversation[] = apiConversations;
      setConversations((prev) => {
        const byId = new Map(prev.map((c) => [c.id, c]));
        merged = apiConversations.map((c) => ({ ...c, msgs: byId.get(c.id)?.msgs ?? [] }));
        // A conversation created optimistically while this fetch was in
        // flight (`c<timestamp>`) can't be in the server's list yet; a pure
        // rebuild from the server deleted it — and the message in it — from
        // under the user, then jumped them to an unrelated thread.
        const inFlight = prev.filter((c) => !isServerConvId(c.id));
        return [...inFlight, ...merged];
      });
      const scope = active.cache ? cacheScopeRef.current : null;
      if (scope) writeCachedList(scope.endpoint, scope.userId, merged);
      // From the *filtered* list, not the raw one. Selecting `convs[0]`
      // meant Chat could open — and then send into — an agent run: the list
      // hid it, but the active id still pointed at it, so a message typed
      // under Chat was written to an agent conversation. Worse than the
      // display leak it accompanied, because it misroutes user content
      // rather than just showing an extra row (#117).
      if (merged.length > 0 && !activeIdRef.current) {
        // A scope may ask for a particular conversation (a routine screen
        // opened on `?c=`), and falls back to the newest when that one is not
        // in the list — deleted, or belonging to another routine.
        const wanted = active.initialActiveId;
        const opening = wanted && merged.some((c) => c.id === wanted) ? wanted : merged[0].id;
        setActiveId(opening);
      }
      setListLoaded(true);
    } catch (err: unknown) {
      if (isUnreachableError(err)) setConnectionState('offline');
      // Still "loaded": the screen has to be able to tell "no chats yet" from
      // "still asking", and a failure is neither — it says so through the
      // offline banner instead of leaving a permanent spinner.
      setListLoaded(true);
    }
  }, [setActiveId]);

  /**
   * A different scope is a different list, so start over.
   *
   * The mount effect below keys on `token`, which does not change when one
   * routine's screen is reused for another — expo-router may keep the `[id]`
   * component mounted across a param change, and the screen would then be
   * showing the previous routine's chats with `activeId` still pointing into
   * them. Chat never reaches this: `CHAT_SCOPE` is a module constant, so the
   * identity it compares against never moves.
   */
  const lastScopeRef = useRef(scope);
  useEffect(() => {
    if (lastScopeRef.current === scope) return;
    lastScopeRef.current = scope;
    loadedConvIdsRef.current.clear();
    activeIdRef.current = null;
    setActiveIdState(null);
    setConversations([]);
    setListLoaded(false);
    loadingRef.current = true;
    void refreshList().finally(() => {
      loadingRef.current = false;
    });
  }, [scope, refreshList]);

  // Cached conversations first, then the server's list.
  //
  // The cache renders immediately so an unreachable host shows the user their
  // threads instead of an empty sidebar; the fetch then replaces it wholesale.
  // A failure is no longer swallowed: it marks the app offline, which is what
  // the banner and the disabled composer key on. Previously this
  // `.catch(() => undefined)` meant a dead server looked identical to a fresh
  // account with nothing in it.
  useEffect(() => {
    if (!token || loadingRef.current) return;
    loadingRef.current = true;

    const scope = scopeRef.current.cache ? cacheScope() : null;
    if (scope) {
      // Filtered on read as well as on fetch: the cache was written from the
      // same unfiltered list, so one already on disk holds agent runs. The
      // fetch rewrites it, but this render happens first — and on an offline
      // start there is no fetch to rewrite anything (#117).
      const cached = readCachedConversations(scope.endpoint, scope.userId)
        .filter((c) => c.kind === scopeRef.current.kind);
      if (cached.length > 0) {
        // Remembered so the history fetch knows these came from the cache and
        // may overwrite them — see loadHistory.
        for (const c of cached) fromCacheRef.current.add(c.id);
        setConversations((prev) => {
          const existing = new Set(prev.map((c) => c.id));
          return [...cached.filter((c) => !existing.has(c.id)), ...prev];
        });
        // Open the newest cached thread straight away. Selecting a
        // conversation was previously only done on the fetch's success path,
        // so an offline start left the list populated but nothing open — the
        // message view never mounted and the user saw an empty pane where
        // their conversation should be.
        if (!activeIdRef.current) setActiveId(cached[0].id);
      }
    }

    void refreshList().finally(() => {
      loadingRef.current = false;
    });
    // `setActiveId` is stable by construction (an empty dep list — see its
    // definition, where `loadedConvIdsRef` dedupes against its identity), but
    // the rule cannot see that across the ref it reads the scope through.
  }, [token, refreshList, cacheScope, setActiveId]);

  /**
   * Keep the cache in step with what is on screen.
   *
   * The list fetch alone is not enough: a conversation created *during* this
   * session — the common case, since you have to talk to it to have anything
   * worth caching — would only be written when the list is next fetched,
   * which may be after the server has already gone away.
   *
   * Written when a conversation *settles* rather than on a timer. A debounce
   * looked simpler but loses the write outright if the app reloads or quits
   * inside the window, which is exactly the moment that matters ("I closed it
   * right after reading the reply"). Skipping conversations that are still
   * streaming avoids a write per token without needing one.
   */
  const cachedIdentityRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const scope = scopeRef.current.cache ? cacheScope() : null;
    if (!scope) return;
    for (const conversation of conversations) {
      if (!isServerConvId(conversation.id)) continue;
      if (conversation.msgs.length === 0) continue;
      if (streamingByConv[conversation.id]) continue;
      // A cheap identity covering what the cache actually stores. Length alone
      // missed every change that isn't a new message — a rename, a model
      // switch — so the cache kept the old value until the host went down and
      // the user saw the auto-generated title in the offline sidebar.
      const last = conversation.msgs[conversation.msgs.length - 1];
      const identity = `${String(conversation.msgs.length)}|${conversation.title}|${conversation.model}|${String(last.id)}|${String(last.text.length)}`;
      if (cachedIdentityRef.current[conversation.id] === identity) continue;
      cachedIdentityRef.current[conversation.id] = identity;
      writeCachedConversation(scope.endpoint, scope.userId, conversation);
    }
  }, [conversations, streamingByConv, cacheScope]);

  // Live streaming socket. A dropped connection no longer needs a reconcile
  // poll: every event carries a monotonic per-stream `seq`, so reconnecting
  // is just re-sending `stream.subscribe` with the last-applied seq per
  // conversation — the server folds its durable log into one `stream.sync`
  // snapshot (covering both "still generating, catch me up" and "finished
  // while I was gone" in the same reply) and resumes live deltas from there.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let intentionalClose = false;

    const resubscribeKnown = () => {
      const ws = wsRef.current;
      if (!ws) return;
      const targets = new Set(Object.keys(streamingByConvRef.current));
      if (activeIdRef.current) targets.add(activeIdRef.current);
      for (const convId of targets) {
        const tracked = streamingByConvRef.current[convId];
        subscribeStreams(
          ws,
          convId,
          tracked ? { [tracked.streamId]: cursorsRef.current[tracked.streamId] ?? 0 } : undefined,
        );
      }
    };

    const onEvent = (event: ServerMessage) => {
      if (event.type === 'turn.started') {
        const realId = event.conversation_id;
        const localId = pendingLocalIdRef.current;
        const modelForPatch = pendingModelRef.current;
        pendingLocalIdRef.current = null;
        pendingModelRef.current = null;
        if (localId && localId !== realId) {
          setConversations((prev) =>
            prev.some((c) => c.id === localId)
              ? prev.map((c) => (c.id === localId ? { ...c, id: realId } : c))
              : prev,
          );
        }
        setActiveId(realId);
        if (modelForPatch) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => undefined);
        }
      } else if (event.type === 'stream.sync') {
        const convId = event.conversation_id;
        const userMsg = event.snapshot.messages.find((m) => m.author_type === 'user');
        if (userMsg) promotePendingUserMsg(convId, userMsg.message_id);
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, msgs: applySnapshotToMsgs(c.msgs, event.snapshot) } : c)),
        );
        // Same "is this sync for the run we're actually tracking" guard as
        // clearStream below — an older, already-finished run's catch-up sync
        // must not clobber a still-active different run's approval state.
        const trackedForApproval = streamingByConvRef.current[convId];
        if (!trackedForApproval || trackedForApproval.streamId === event.stream_id) {
          setPendingApprovalByConv((prev) => {
            const pa = event.snapshot.pending_approval;
            if (!pa) {
              if (!(convId in prev)) return prev;
              return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
            }
            return { ...prev, [convId]: { callId: pa.call_id, tool: pa.tool, args: pa.args } };
          });
          setPendingCheckinByConv((prev) => {
            const pc = event.snapshot.pending_checkin;
            if (!pc) {
              if (!(convId in prev)) return prev;
              return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
            }
            return {
              ...prev,
              [convId]: {
                n: pc.n,
                max: pc.max,
                reason: pc.reason,
                ...(pc.pattern ? { pattern: pc.pattern } : {}),
              },
            };
          });
        }
        if (event.status !== 'active') {
          // A reconnect's catch-up re-syncs the conversation's last few
          // runs, not just the current one — an older, already-finished
          // run's sync arriving here must not wipe tracking for a
          // genuinely still-active *different* run in the same
          // conversation. Only clear if this sync is for the stream we're
          // actually tracking (or nothing is tracked, so there's nothing to
          // protect).
          const tracked = streamingByConvRef.current[convId];
          if (!tracked || tracked.streamId === event.stream_id) clearStream(convId);
        } else {
          // Either updates a stream we already knew was in flight, or
          // discovers one we didn't (app restart mid-stream, another
          // device's send) — in the latter case there's no local record of
          // when it truly started or which model, so approximate from here
          // and the snapshot's own assistant message.
          // Synchronously, before any further event can be handled.
          cursorsRef.current[event.stream_id] = event.seq;
          const assistantMsg = event.snapshot.messages.find((m) => m.author_type === 'assistant');
          setStreamingByConv((prev) => ({
            ...prev,
            [convId]:
              prev[convId]?.streamId === event.stream_id
                ? prev[convId]
                : {
                    streamId: event.stream_id,
                    loadingModel: false,
                    // `run.queued` is only re-emitted when the queue moves, so
                    // a client that (re)connects while its run sits at a stable
                    // position hears nothing further until the run ahead ends —
                    // the snapshot is its only source for the wait.
                    queuePosition: event.snapshot.queued?.position ?? null,
                    responseStartedAt: Date.now(),
                    model: assistantMsg?.model ?? '',
                  },
          }));
        }
      } else if (event.type === 'stream.event') {
        const convId = event.conversation_id;
        const lastSeq = cursorsRef.current[event.stream_id];
        if (lastSeq !== undefined && event.seq !== lastSeq + 1) {
          // Gap — a delta was missed (backpressure drop, brief hiccup).
          // Re-subscribe from our last-known cursor to resync exactly rather
          // than silently rendering out-of-order/incomplete text.
          //
          // Rate-limited: a resync is not instantaneous, so without this every
          // event arriving in the meantime asks for another one. At streaming
          // rates that is hundreds of requests a second, and since each reply
          // carries a full snapshot it saturates the socket badly enough to
          // cause the very drops it is trying to repair.
          const now = Date.now();
          const lastAsk = lastResyncAtRef.current[event.stream_id] ?? 0;
          const ws = wsRef.current;
          if (ws && now - lastAsk > RESYNC_COOLDOWN_MS) {
            lastResyncAtRef.current[event.stream_id] = now;
            subscribeStreams(ws, convId, { [event.stream_id]: lastSeq });
          }
          return;
        }
        // Synchronously, before the next event in this same tick is handled.
        cursorsRef.current[event.stream_id] = event.seq;
        setStreamingByConv((prev) =>
          prev[convId]?.streamId === event.stream_id
            ? {
                ...prev,
                [convId]: {
                  ...prev[convId],
                  loadingModel: event.event.kind === 'model.loading',
                  // Cleared by anything that is not itself a queue update:
                  // every other event means the run is past the queue, and a
                  // stale position would keep claiming otherwise.
                  queuePosition:
                    event.event.kind === 'run.queued' ? event.event.position : null,
                },
              }
            : prev,
        );
        if (event.event.kind === 'message.start' && event.event.author_type === 'user') {
          promotePendingUserMsg(convId, event.event.message_id);
        }
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, msgs: applyEventToMsgs(c.msgs, event.event) } : c)),
        );
        const inner = event.event;
        if (inner.kind === 'approval.request') {
          setPendingApprovalByConv((prev) => ({
            ...prev,
            [convId]: { callId: inner.call_id, tool: inner.tool, args: inner.args },
          }));
        } else if (inner.kind === 'tool.result') {
          setPendingApprovalByConv((prev) => {
            if (prev[convId]?.callId !== inner.call_id) return prev;
            return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
          });
        } else if (inner.kind === 'steps.checkin') {
          setPendingCheckinByConv((prev) => ({
            ...prev,
            [convId]: {
              n: inner.n,
              max: inner.max,
              reason: inner.reason,
              ...(inner.pattern ? { pattern: inner.pattern } : {}),
            },
          }));
        } else if (inner.kind === 'steps.decision' || inner.kind === 'iteration') {
          // Answered — here, on another device, or by the timeout. Reaching a
          // new iteration means the same thing.
          setPendingCheckinByConv((prev) => {
            if (!(convId in prev)) return prev;
            return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
          });
        }
        if (inner.kind === 'message.end' && inner.status === 'error' && inner.error) {
          // See useAgentSession: remembered so stream.end can tell whether its
          // run-level reason is something the bubble is not already saying.
          lastMessageErrorRef.current.set(event.stream_id, inner.error);
        }
      } else if (event.type === 'stream.end') {
        // The message's own final state (text/usage/status) already landed
        // via its `message.end` stream.event, which is guaranteed to have
        // arrived first — WS delivery is ordered, and the server only sends
        // stream.end after the producer's last flush completes. This just
        // clears the "something is streaming" UI state.
        clearStream(event.conversation_id);
        // Safety net: a run that ends without an explicit tool.result for a
        // still-pending call (denied via timeout, aborted) must not leave a
        // dialog on screen for a call nothing will ever resolve.
        setPendingApprovalByConv((prev) => {
          const convId = event.conversation_id;
          if (!(convId in prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
        });
        setPendingCheckinByConv((prev) => {
          const convId = event.conversation_id;
          if (!(convId in prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
        });
        // The run-level reason, which no message row carries — the step limit
        // used to be exactly that and nothing showed it (#157). Only when the
        // failed message is not already saying the same thing in red.
        if (event.status === 'error' && event.error && lastMessageErrorRef.current.get(event.stream_id) !== event.error) {
          showToast(event.error, 6000);
        }
        lastMessageErrorRef.current.delete(event.stream_id);
        // A run may have JIT-loaded the model, which changes the context
        // window out from under a model list fetched at mount.
        onStreamEndRef.current?.();
      } else if (event.type === 'error') {
        showToast(event.error || 'Chat error', 6000);
      }
    };

    const connect = () => {
      const ws = createChatSocket(token, onEvent);
      ws.onopen = () => {
        attempt = 0;
        setConnectionState('online');
        resubscribeKnown();
      };
      ws.onclose = () => {
        if (cancelled) return;
        // The foreground-resume handler below closes the socket *on purpose*
        // to replace a possibly-zombie connection. That is not a drop, and
        // reading it as one flashed the offline banner and refused sends for
        // a second on every single app switch on a healthy server.
        if (intentionalClose) {
          intentionalClose = false;
          reconnectTimer = setTimeout(connect, 0);
          return;
        }
        // The first drop is "reconnecting"; once retries have been failing
        // for a while it is honestly just offline. Distinguishing them keeps
        // the banner from flapping on a momentary blip while still telling
        // the truth when the host is actually gone.
        setConnectionState(attempt >= 2 ? 'offline' : 'reconnecting');
        // The stream state itself is preserved (see StreamState comment) —
        // only the connection needs re-establishing.
        attempt += 1;
        const delay = Math.min(1000 * attempt, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };
      wsRef.current = ws;
    };
    connect();

    // A short background spell (switching apps for a few seconds) rarely
    // closes the socket outright — mobile OSes give a grace period before
    // suspending network activity — but it does freeze the JS thread, so a
    // stream.event that arrives while backgrounded can be lost to the
    // native WebSocket bridge losing sync across the pause. Verified on a
    // real iOS Simulator: this can leave the connection a "zombie" — it
    // delivers whatever was already buffered when the app resumes, then
    // never receives another byte, with no close event on either end.
    // Force-closing on every foreground resume guarantees a fresh
    // connection; resubscribing with real cursors on the new connection is
    // exact regardless of how the old one died.
    let appState: AppStateStatus = AppState.currentState;
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(appState) && next === 'active') {
        intentionalClose = true;
        wsRef.current?.close();
      }
      appState = next;
    });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      appStateSub.remove();
      wsRef.current?.close();
    };
  }, [token, endpoint, setActiveId, showToast, clearStream, setStreamingByConv, promotePendingUserMsg]);

  const handleSend = useCallback(
    (text: string, model: string, attachments?: AttachmentRef[]) => {
      if (!wsRef.current) return;
      // A send while the socket is down used to paint an optimistic bubble and
      // then vanish: trySend returned false and nothing looked at it, so the
      // message appeared sent and never got a reply. Refuse up front and say
      // so, rather than lying and then losing it.
      if (isOffline()) {
        showToast('Not connected — your message was not sent');
        return;
      }
      const localMsgId = `lm${String(Date.now())}`;
      pendingUserMsgIdRef.current = localMsgId;
      // The optimistic bubble keeps the full refs so it can render a thumbnail
      // immediately; the wire only needs the ids.
      const refs = attachments?.map((a) => a.ref);
      if (!activeIdRef.current && !scopeRef.current.allowCreate) {
        // A routine's chats exist because a run created them. Sending with
        // nothing open would open a *chat* conversation from the routines
        // screen — a thread that then belongs to neither surface.
        showToast('Run this routine first — there is no chat to continue yet');
        return;
      }
      if (!activeIdRef.current) {
        const localId = `c${String(Date.now())}`;
        pendingLocalIdRef.current = localId;
        pendingModelRef.current = model;
        const newConv: Conversation = {
          id: localId,
          title: text.slice(0, 40) || (attachments?.[0]?.name ?? 'Attachment'),
          kind: 'chat',
          time: 'now',
          model,
          location: 'server',
          msgs: [{ id: localMsgId, role: 'user', text, attachments }],
        };
        setConversations((prev) => [newConv, ...prev]);
        setActiveId(newConv.id);
        if (!sendChatMessage(wsRef.current, text, model, undefined, undefined, refs)) {
          // Undo, don't just toast. The bubble was already painted, and the
          // cache-on-settle effect would have persisted a message that was
          // never sent into the user's "saved copy" — replayed on every
          // offline start thereafter. A phantom empty conversation too.
          setConversations((prev) => prev.filter((c) => c.id !== localId));
          setActiveId(null);
          pendingLocalIdRef.current = null;
          pendingModelRef.current = null;
          pendingUserMsgIdRef.current = null;
          setConnectionState('reconnecting');
          showToast('Not connected — your message was not sent');
        }
      } else {
        const id = activeIdRef.current;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === id
              ? { ...c, msgs: [...c.msgs, { id: localMsgId, role: 'user', text, attachments }] }
              : c,
          ),
        );
        if (!sendChatMessage(wsRef.current, text, model, id, undefined, refs)) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, msgs: c.msgs.filter((m) => m.id !== localMsgId) } : c)),
          );
          pendingUserMsgIdRef.current = null;
          setConnectionState('reconnecting');
          showToast('Not connected — your message was not sent');
        }
      }
    },
    [setActiveId, showToast],
  );

  const handleStop = useCallback(() => {
    const id = activeIdRef.current;
    const stream = id ? streamingByConvRef.current[id] : undefined;
    if (!wsRef.current || !id || !stream) {
      // See useAgentSession: silence here is indistinguishable from a broken
      // button, and the run carries on either way (#113).
      showToast('Not connected to this run — reload the page and try again', 4000);
      return;
    }
    // `wsRef.current` is never nulled on close (a reconnect just re-assigns
    // it), so the guard above passes with a CLOSED socket in hand during a
    // reconnect. stopStream refuses to send on one and says so; without
    // reading that, the header showed "Stopping…" with the button disabled
    // until the run ended on its own — the shape of #113 again.
    if (!stopStream(wsRef.current, stream.streamId)) {
      showToast('Not connected to this run — reload the page and try again', 4000);
      return;
    }
    setStoppingConvId(id);
  }, [showToast]);

  const clearApproval = useCallback((convId: string) => {
    setPendingApprovalByConv((prev) => {
      if (!(convId in prev)) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== convId));
    });
  }, []);

  const handleApprove = useCallback(
    (callId: string) => {
      if (wsRef.current) approveTool(wsRef.current, callId);
      if (activeIdRef.current) clearApproval(activeIdRef.current);
    },
    [clearApproval],
  );

  const handleDeny = useCallback(
    (callId: string) => {
      if (wsRef.current) denyTool(wsRef.current, callId);
      if (activeIdRef.current) clearApproval(activeIdRef.current);
    },
    [clearApproval],
  );

  /** Answers a step check-in — see useAgentSession.handleSteps. Chat and agent
   * share one tool loop, so chat runs park exactly the same way. */
  const handleSteps = useCallback(
    (decision: StepsDecision) => {
      const id = activeIdRef.current;
      const stream = id ? streamingByConvRef.current[id] : undefined;
      if (!wsRef.current || !id || !stream || !sendStepsDecision(wsRef.current, stream.streamId, decision)) {
        showToast('Not connected to this run — reload the page and try again', 4000);
        return;
      }
      setPendingCheckinByConv((prev) => {
        if (!(id in prev)) return prev;
        return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
      });
    },
    [showToast],
  );

  /** "Allow always": persists the tool's approval policy before approving
   * this call — an MCP tool patches its server's per-tool policy (the same
   * allowlist the /mcp screen's tool sheet manages), a builtin patches the
   * user's global tool_allowlist (PATCH /v1/prefs). If the persist fails,
   * this call is still approved — the user's "allow" click is honored now,
   * they just weren't spared the next prompt too. */
  const handleAllowAlways = useCallback(
    async (callId: string, tool: string) => {
      try {
        const mcp = splitMcpTool(tool);
        if (mcp) {
          const servers = await getMcpServers();
          const server = servers.find((s) => s.slug === mcp.slug);
          if (server) {
            await updateMcpServer(server.id, { toolPolicies: { [mcp.remoteName]: { approval: 'allow' } } });
          }
        } else {
          const prefs = await getPrefs();
          await updatePrefs({ toolAllowlist: [...new Set([...prefs.toolAllowlist, tool])] });
        }
      } catch {
        showToast('Could not save "always allow" — approved just this once');
      }
      handleApprove(callId);
    },
    [handleApprove, showToast],
  );

  /** Runs a built-in slash command (currently just "compact") against the
   * active conversation. Unlike handleSend, there's no optimistic bubble to
   * push — the command has no user-authored message, only its result. */
  const handleCommand = useCallback((name: string, args: string, model: string) => {
    const id = activeIdRef.current;
    if (!wsRef.current || !id) return;
    sendCommand(wsRef.current, name, id, model, args || undefined);
  }, []);

  const handleNewChat = useCallback(() => { setActiveId(null); }, [setActiveId]);

  const handleFork = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const conv = prev.find((c) => c.id === id);
        if (!conv) return prev;
        const forked: Conversation = {
          ...conv,
          id: `c${String(Date.now())}`,
          title: `${conv.title} (fork)`,
          time: 'now',
          msgs: conv.msgs.slice(0, Math.ceil(conv.msgs.length / 2)),
        };
        setActiveId(forked.id);
        return [forked, ...prev];
      });
      showToast('Conversation forked');
    },
    [setActiveId, showToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      // The server first, and only then the local state. This used to be
      // local-only: the row vanished from the sidebar, the server never heard
      // about it, and it came back on the next load — a delete that undid
      // itself. A conversation that never reached the server (created offline,
      // not yet round-tripped) has nothing to delete there, so it is removed
      // locally without one.
      if (isServerConvId(id)) {
        try {
          await deleteConversation(id);
        } catch (err) {
          showToast(
            isUnreachableError(err)
              ? 'Could not delete — the server is unreachable'
              : `Could not delete: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      // Decided from the ref, before the state update — never from inside the
      // updater. React runs an updater eagerly only when the fiber has nothing
      // pending; with another update already queued (a stream event from a
      // background run, the confirm dialog's own `setDeletingId(null)`) it is
      // deferred to the render, so a variable assigned inside it is still its
      // initialiser on the next line. That made "open the next chat along"
      // pick nothing, intermittently, in exactly the scope it was added for.
      const nextAlong = conversationsRef.current.find((c) => c.id !== id)?.id ?? null;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      // The cache has no other pruning path that works offline — without
      // this the deleted thread came straight back on the next offline start.
      const scope = scopeRef.current.cache ? cacheScopeRef.current : null;
      if (scope) removeCachedConversation(scope.endpoint, scope.userId, id);
      if (activeIdRef.current === id) {
        // In a scope that cannot create one, landing on nothing means an
        // empty screen with no way off it — open the next chat along instead.
        setActiveId(scopeRef.current.allowCreate ? null : nextAlong);
      }
      showToast('Conversation deleted');
    },
    [setActiveId, showToast],
  );

  const handleRename = useCallback(
    (id: string, name: string) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: name } : c)));
    },
    [],
  );

  const setConversationModel = useCallback((id: string, modelId: string) => {
    updateConversation(id, { model_pref: { model: modelId } }).catch(() => undefined);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, model: modelId } : c)));
  }, []);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;
  // Scoped to the active conversation on purpose — a background thread that's
  // still streaming must never light up the stop button, elapsed timer, or
  // typing indicator for whichever conversation the user has switched to.
  const activeStream = activeId ? streamingByConv[activeId] : undefined;

  return {
    conversations,
    listLoaded,
    refreshList,
    activeId,
    activeConv,
    setActiveId,
    streaming: !!activeStream,
    // Overlaid on the live stream state, not replacing it: the run is still
    // streaming until it actually ends.
    stopping: activeId !== null && stoppingConvId === activeId,
    loadingModel: activeStream?.loadingModel ?? false,
    queuePosition: activeStream?.queuePosition ?? null,
    responseStartedAt: activeStream?.responseStartedAt ?? null,
    pendingApproval: activeId ? (pendingApprovalByConv[activeId] ?? null) : null,
    pendingCheckin: activeId ? (pendingCheckinByConv[activeId] ?? null) : null,
    handleSend,
    handleStop,
    handleCommand,
    handleNewChat,
    handleApprove,
    handleDeny,
    handleSteps,
    handleAllowAlways,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
  };
}
