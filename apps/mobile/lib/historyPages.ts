import type { Message } from './types'

/**
 * Where a thread's history can be read back from (#213).
 *
 * A thread opens on its newest page; this is the cursor for the page older
 * than everything loaded so far. Absent for a thread whose history was never
 * fetched (optimistic, offline, or only ever seen live), and for a server that
 * predates paging — in both cases there is nothing to ask for.
 */
export interface HistoryPaging {
  /** The `before` cursor for the next older page; null when there is none. */
  before: string | null
  loading: boolean
}

/** From a page response. A server without paging sends neither field, and its
 * one page was all it would ever give — so absent reads as "no more". */
export function pagingFrom(page: { hasMore?: boolean; before?: string | null }): HistoryPaging {
  return { before: page.hasMore && page.before ? page.before : null, loading: false }
}

/**
 * History merged into what is loaded, in the thread's own order.
 *
 * Deduplicated by id in favour of what is already on screen: the loaded copy
 * may be live (a message still streaming, or one a snapshot has updated since
 * the page was read), and a page is only ever the stored one. Messages without
 * an id — an optimistic bubble — are always kept.
 *
 * Placed by `lamport`, the server's replay order, never simply in front. What
 * is loaded is not always newer than the page: a reconnect replays the
 * conversation's last three runs, and on a thread opened as the socket comes
 * up those snapshots can land before the newest page does. A planning run is
 * small and the run after it can be hundreds of rows, so its plan arrived
 * first, the page was put in front of it, and the plan ended up below the
 * whole implementation it had led to — with nothing after it, so it read as
 * waiting for a decision and offered Accept again (found on the beta, #281's
 * thread). Each history message goes before the first loaded message known to
 * come after it; one with nothing loaded after it goes after the last loaded
 * message that has a position, ahead of any bubble still being sent.
 *
 * A message with no `lamport` (a server older than #213) cannot be placed, so
 * such history goes in front, as it always did.
 */
function mergeHistory(current: readonly Message[], history: readonly Message[]): Message[] {
  const have = new Set(current.flatMap((m) => (m.id ? [m.id] : [])))
  const incoming = history.filter((m) => !m.id || !have.has(m.id))
  if (incoming.length === 0) return [...current]
  let lastPlaced = current.length - 1
  while (lastPlaced >= 0 && current[lastPlaced].lamport === undefined) lastPlaced--
  if (lastPlaced < 0 || incoming.some((m) => m.lamport === undefined)) return [...incoming, ...current]
  // Both sides are in order, so one pass merges them: before each loaded
  // message with a position, everything from history that sorts before it.
  const sorted = incoming
    .flatMap((m) => (m.lamport === undefined ? [] : [{ m, lamport: m.lamport }]))
    .sort((x, y) => x.lamport - y.lamport)
  const out: Message[] = []
  let next = 0
  const flushUpTo = (limit: number) => {
    while (next < sorted.length && sorted[next].lamport <= limit) out.push(sorted[next++].m)
  }
  current.forEach((m, i) => {
    if (m.lamport !== undefined) flushUpTo(m.lamport)
    out.push(m)
    if (i === lastPlaced) flushUpTo(Infinity)
  })
  return out
}

/** An older page, merged into what is loaded (see `mergeHistory`). */
export function prependOlder(current: readonly Message[], older: readonly Message[]): Message[] {
  return mergeHistory(current, older)
}

/**
 * A thread with its newest page of history applied — always applied, never
 * skipped, which is what keeps the page's cursor true.
 *
 * - An empty thread is the page.
 * - A thread filled from the offline cache is replaced by it: the server's copy
 *   has whatever other devices added since.
 * - A thread a live run or a reconnect's snapshot has already started filling
 *   keeps those messages, with the page's history merged in by position
 *   (mergeHistory: the live copy of a message both have wins).
 *
 * Skipping the page in that last case was the old rule, and it made the page's
 * cursor a lie: paging back from the page's oldest row, with the page itself
 * never shown, skipped every row in between. Deciding whether to record the
 * cursor from a ref instead only moved the lie, since the ref and the state
 * update can see different threads. Applying the page every time leaves nothing
 * to decide.
 */
export function withNewestPage(current: readonly Message[], page: readonly Message[], fromCache: boolean): Message[] {
  if (current.length === 0 || fromCache) return [...page]
  return mergeHistory(current, page)
}
