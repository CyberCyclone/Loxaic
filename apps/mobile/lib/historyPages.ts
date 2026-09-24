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
 * An older page, put in front of what is loaded.
 *
 * Deduplicated by id in favour of what is already on screen: the loaded copy
 * may be live (a message still streaming, or one a snapshot has updated since
 * the page was read), and the older page is only ever the stored one. Messages
 * without an id — an optimistic bubble — are always kept.
 */
export function prependOlder(current: readonly Message[], older: readonly Message[]): Message[] {
  const have = new Set(current.flatMap((m) => (m.id ? [m.id] : [])))
  return [...older.filter((m) => !m.id || !have.has(m.id)), ...current]
}
