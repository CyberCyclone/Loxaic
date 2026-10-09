import type { PromptStats, ServerMessage } from '@loxaic/api-client';
import type { Message } from '@/lib/types';
import { withNewestPage } from '@/lib/historyPages';
import { foldPromptStats, loadingAfter } from '@/lib/promptStats';
import { localRunStart } from '@/lib/runStart';
import { applyEventToMsgs, applySnapshotToMsgs } from '@/lib/streamMessages';

/**
 * One sub-agent's transcript, as its panel shows it.
 *
 * A child is an ordinary run with its own conversation and stream, so this is
 * the same story a thread has, on a smaller stage: stored history from REST,
 * a `stream.sync` snapshot of its run, then its live events. The folds are the
 * thread's own (`applySnapshotToMsgs`, `applyEventToMsgs`) — a child's
 * messages are built by exactly the code that builds its parent's.
 *
 * Kept apart from a thread's state on purpose. A child's stream arrives on the
 * same socket as its parent's, and the session hooks key everything by
 * conversation id: applied there, a child's events would be dropped as an
 * unknown thread at best, and at worst clear the parent's pending send, toast
 * its errors on the parent's screen, and refetch the model list per child.
 *
 * Pure: the hook (`useSubAgentState`) holds the state, the socket and the
 * cursors.
 */
export interface ChildTranscript {
  msgs: Message[];
  /** Whether its stored history has been asked for (and answered, or failed). */
  historyLoaded: boolean;
  /** The run while it is going: what the typing line under the transcript
   * needs. Null once the stream has ended, or before it has been heard from. */
  live: ChildLive | null;
}

export interface ChildLive {
  streamId: string;
  loadingModel: boolean;
  promptStats: PromptStats | null;
  /** The run's start, on this device's clock. */
  responseStartedAt: number;
  model: string;
}

export const EMPTY_TRANSCRIPT: ChildTranscript = { msgs: [], historyLoaded: false, live: null };

type Sync = Extract<ServerMessage, { type: 'stream.sync' }>;
type StreamEvent = Extract<ServerMessage, { type: 'stream.event' }>;
type StreamEnd = Extract<ServerMessage, { type: 'stream.end' }>;

/**
 * The child's stored messages, put in front of whatever its live run has
 * already written — never instead of it, for the reason a thread does the
 * same (`withNewestPage`): the live copy of a message both have is the newer.
 */
export function withChildHistory(t: ChildTranscript, history: readonly Message[]): ChildTranscript {
  return { ...t, historyLoaded: true, msgs: withNewestPage(t.msgs, history, false) };
}

/** A history fetch that failed still counts as asked: the panel then says so
 * rather than spinning, and the live run fills in what it can. */
export function historyAsked(t: ChildTranscript): ChildTranscript {
  return t.historyLoaded ? t : { ...t, historyLoaded: true };
}

export function applyChildSync(t: ChildTranscript, event: Sync, now = Date.now()): ChildTranscript {
  const msgs = applySnapshotToMsgs(t.msgs, event.snapshot, { olderUnloaded: false, serverNow: event.server_now, now });
  if (event.status !== 'active') {
    // A finished run's snapshot: only this run's own "live" is cleared, so the
    // catch-up of an older stream cannot end a newer one. (A child has one
    // run, but the rule costs nothing and is the thread's.)
    return { ...t, msgs, live: t.live && t.live.streamId !== event.stream_id ? t.live : null };
  }
  const assistant = event.snapshot.messages.find((m) => m.author_type === 'assistant');
  const live: ChildLive =
    t.live?.streamId === event.stream_id
      ? { ...t.live, promptStats: event.snapshot.prompt_stats ?? null }
      : {
          streamId: event.stream_id,
          loadingModel: false,
          promptStats: event.snapshot.prompt_stats ?? null,
          responseStartedAt: localRunStart(event.started_at, event.server_now, now),
          model: assistant?.model ?? '',
        };
  return { ...t, msgs, live };
}

export function applyChildEvent(t: ChildTranscript, event: StreamEvent): ChildTranscript {
  const msgs = applyEventToMsgs(t.msgs, event.event);
  let live = t.live;
  if (live?.streamId === event.stream_id) {
    const promptStats = foldPromptStats(live.promptStats, event.event);
    const loadingModel = loadingAfter(live.loadingModel, event.event);
    const model = event.event.kind === 'message.start' && event.event.model ? event.event.model : live.model;
    if (promptStats !== live.promptStats || loadingModel !== live.loadingModel || model !== live.model) {
      live = { ...live, promptStats, loadingModel, model };
    }
  }
  return msgs === t.msgs && live === t.live ? t : { ...t, msgs, live };
}

export function applyChildEnd(t: ChildTranscript, event: StreamEnd): ChildTranscript {
  if (t.live?.streamId !== event.stream_id) return t;
  return { ...t, live: null };
}
