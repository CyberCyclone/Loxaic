import type { RunActivity, ServerMessage } from '@loxaic/api-client'
import { isServerConvId } from './streamMessages'
import { rowRunLabel, STATE_DOT, type RowRunState } from './runStateCopy'

/**
 * Bookkeeping for the thread list's liveness watch (#282).
 *
 * The wire side is `conversations.watch` / `conversation.run`
 * (packages/types, ws/delivery.ts). This is the client half, kept pure so the
 * rules can be tested without a socket or a renderer:
 *
 * - **The watch is a replacement set.** Whatever the list shows, it watches;
 *   an id leaves the watch when its row leaves the list. Client-side ids
 *   (the optimistic placeholders `isServerConvId` rejects) are never sent —
 *   one reaching Postgres is a known failure mode (streams/authz.ts).
 * - **A notice is replacement, not a delta.** `run: null` means the row is
 *   idle; anything else is the whole truth about what its run is doing.
 * - **A new socket starts with nothing known.** The server does not replay
 *   notices across sockets, and a badge carried over from a dead socket could
 *   outlive the run it described with nothing to correct it. An absent notice
 *   renders no badge, which is the honest reading of "we have not been told".
 */

/** What one row was last told about its run. */
export interface RunNotice {
  activity: RunActivity
  /** Only meaningful alongside `queued`. */
  queuePosition?: number
}

export type RunNotices = Partial<Record<string, RunNotice>>

/** The ids worth watching: server ids only, deduped, capped the way the
 * server caps its side (a client that kept everything it had ever seen would
 * otherwise grow the watch without limit). */
export const MAX_WATCH_IDS = 100

export function watchIdsFor(conversationIds: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of conversationIds) {
    if (seen.has(id) || !isServerConvId(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_WATCH_IDS) break
  }
  return out
}

/** Do two watch sets differ? Set order is irrelevant on the wire; comparing
 * sorted contents is what stops a re-render of the same list from sending a
 * fresh watch every time the conversations array gets a new identity. */
export function watchSetsDiffer(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return true
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.some((id, i) => id !== sortedB[i])
}

/** Fold one socket message. Returns `prev` untouched for everything that is
 * not a liveness notice about a conversation, so the caller can feed it the
 * whole stream without a type filter of its own. */
export function runNoticesAfterMessage(prev: RunNotices, message: ServerMessage): RunNotices {
  if (message.type === 'conversation.run') {
    if (message.run === null) {
      if (!(message.conversation_id in prev)) return prev
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== message.conversation_id))
    }
    const next: RunNotice = {
      activity: message.run,
      ...(message.run === 'queued' && message.queue_position ? { queuePosition: message.queue_position } : {}),
    }
    const had = prev[message.conversation_id]
    if (had?.activity === next.activity && had.queuePosition === next.queuePosition) return prev
    return { ...prev, [message.conversation_id]: next }
  }
  return prev
}

/** `notices` without one conversation (deleted). */
export function withoutRunNotice(notices: RunNotices, conversationId: string): RunNotices {
  if (!(conversationId in notices)) return notices
  return Object.fromEntries(Object.entries(notices).filter(([key]) => key !== conversationId))
}

/** What a row draws. The badge is `label` beside a dot in colour `dot`, both
 * from the header's vocabulary (lib/runStateCopy). */
export interface RowRunBadge {
  state: RowRunState
  label: string
  dot: string
}

/**
 * The badges for one render: the notices, with `stopping` overlaid.
 *
 * `stoppingConvId` is the conversation whose Stop was pressed and whose stream
 * has not ended yet (#113) — a client-side acknowledgement with no server
 * counterpart, so the server's notice for it still says `running` and the row
 * says what the user did. It overlays whatever the notice says (a run parked
 * on an approval and stopped is still winding down) and outranks it, because
 * the last thing the person did is what the row should confirm.
 */
export function threadRunBadges(
  notices: RunNotices,
  stoppingConvId: string | null,
): Partial<Record<string, RowRunBadge>> {
  const has = Object.keys(notices).length > 0
  if (!has && !stoppingConvId) return {}
  const out: Partial<Record<string, RowRunBadge>> = {}
  for (const [id, notice] of Object.entries(notices)) {
    if (!notice) continue
    out[id] = badgeFor(notice, stoppingConvId === id)
  }
  // Stopping with no notice at all (the watch never answered, an older
  // server): still worth the acknowledgement on the row the user just acted
  // on, but only there.
  if (stoppingConvId && !out[stoppingConvId]) {
    out[stoppingConvId] = { state: 'stopping', label: rowRunLabel('stopping'), dot: STATE_DOT.stopping }
  }
  return out
}

function badgeFor(notice: RunNotice, stopping: boolean): RowRunBadge {
  const state: RowRunState = stopping ? 'stopping' : notice.activity
  return {
    state,
    label: rowRunLabel(state, notice.queuePosition),
    dot: STATE_DOT[state],
  }
}
