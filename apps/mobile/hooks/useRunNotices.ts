import { useCallback, useRef, useState, type RefObject } from 'react'
import { watchConversationRuns, type RunActivity, type ServerMessage } from '@loxaic/api-client'
import {
  runNoticesAfterMessage,
  runNoticesWithin,
  threadRunBadges,
  watchIdsFor,
  watchSetsDiffer,
  withoutRunNotice,
  type RunNotices,
  type RowRunBadge,
} from '@/lib/runWatch'

/**
 * The thread list's liveness watch (#282): which of the listed conversations
 * have a run going, and what each is doing.
 *
 * Shape follows `useSubAgentState`: it is handed the session's socket ref and
 * folds socket messages fed to it, so it rides the one socket the surface
 * already keeps rather than opening a second. The rules themselves are pure
 * (lib/runWatch.ts); this is the wiring.
 *
 * One instance per surface (chat, agent, routine history). Each watches the
 * conversations *its* list shows — which is also what makes a badge disappear
 * with the row it belonged to.
 */
export function useRunNotices(wsRef: RefObject<WebSocket | null>) {
  const [notices, setNotices] = useState<RunNotices>({})
  /** The set the live socket was last sent, so a re-render of an unchanged
   * list sends nothing. null: nothing sent on this socket yet. */
  const sentRef = useRef<string[] | null>(null)
  /** The ids to (re)send when a socket opens — kept in a ref because the WS
   * effect's closure is only re-created on [token]. */
  const currentIdsRef = useRef<string[]>([])

  /** Called from the surface's render path (an effect on its conversations)
   * with the ids its list shows. */
  const watch = useCallback(
    (conversationIds: string[]) => {
      const ids = watchIdsFor(conversationIds)
      currentIdsRef.current = ids
      // Forget with the server: a notice for a row that left the watch would
      // have nothing left to correct it (runNoticesWithin).
      setNotices((prev) => runNoticesWithin(prev, ids))
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) return
      if (sentRef.current && !watchSetsDiffer(sentRef.current, ids)) return
      sentRef.current = ids
      watchConversationRuns(ws, ids)
    },
    [wsRef],
  )

  /** From the surface's socket `onopen`, alongside `resubscribeKnown`. A new
   * socket has heard no notices, and the server does not replay them: whatever
   * the last socket was told may already be false, so the map starts empty
   * rather than keeping a badge nothing can correct. */
  const onSocketOpen = useCallback(() => {
    sentRef.current = null
    setNotices({})
    const ids = currentIdsRef.current
    const ws = wsRef.current
    if (!ids.length || ws?.readyState !== WebSocket.OPEN) return
    sentRef.current = ids
    watchConversationRuns(ws, ids)
  }, [wsRef])

  /** Fold one socket message. Returns nothing; the surface keeps handling the
   * event itself — a `conversation.run` is consumed here and falls through
   * every branch of its own switch. */
  const observe = useCallback((message: ServerMessage) => {
    // Cheap filter first: this is called with every message on the socket.
    if (message.type !== 'conversation.run') return
    setNotices((prev) => {
      const next = runNoticesAfterMessage(prev, message)
      return next === prev ? prev : next
    })
  }, [])

  /** A deleted conversation takes its notice with it. */
  const forget = useCallback((conversationId: string) => {
    setNotices((prev) => withoutRunNotice(prev, conversationId))
  }, [])

  return { notices, watch, onSocketOpen, observe, forget }
}

/** Badges keyed by conversation id, for `ThreadList`'s `runStatus` prop: the
 * notices with the local `stopping` acknowledgement overlaid (#113). Exported
 * as a separate helper so each surface computes it where its `stoppingConvId`
 * lives. */
export function rowBadgesFor(notices: RunNotices, stoppingConvId: string | null): Partial<Record<string, RowRunBadge>> {
  return threadRunBadges(notices, stoppingConvId)
}

export type { RunActivity, RowRunBadge }
