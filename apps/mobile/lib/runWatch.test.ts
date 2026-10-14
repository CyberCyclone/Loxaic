import { describe, expect, it } from 'vitest'
import {
  routineRecordCheck,
  rowsNoLongerLive,
  runNoticesAfterMessage,
  runNoticesWithin,
  threadRunBadges,
  watchIdsFor,
  watchSetsDiffer,
  withoutRunNotice,
  type RunNotices,
} from './runWatch'

/** A real server conversation id, and the two shapes a client invents. */
const ID_A = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
const ID_B = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e'

describe('watchIdsFor', () => {
  it('keeps server ids and drops the client’s own placeholders', () => {
    // A `c1790483463291` reaching Postgres is a known failure mode
    // (streams/authz.ts); the watch must never send one.
    expect(watchIdsFor([ID_A, 'c1790483463291', 'pending-xyz'])).toEqual([ID_A])
  })

  it('dedupes and holds the cap', () => {
    const ids = Array.from({ length: 130 }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)
    const watched = watchIdsFor([...ids, ...ids])
    expect(watched).toHaveLength(100)
    expect(watched[0]).toBe(ids[0])
  })
})

describe('watchSetsDiffer', () => {
  it('reads a re-render of the same list as no change', () => {
    expect(watchSetsDiffer([ID_A, ID_B], [ID_B, ID_A])).toBe(false)
  })
  it('notices an id added and an id removed', () => {
    expect(watchSetsDiffer([ID_A], [ID_A, ID_B])).toBe(true)
    expect(watchSetsDiffer([ID_A, ID_B], [ID_A])).toBe(true)
  })
})

describe('runNoticesAfterMessage', () => {
  it('records a running notice and clears it on null', () => {
    let notices: RunNotices = {}
    notices = runNoticesAfterMessage(notices, { type: 'conversation.run', conversation_id: ID_A, run: 'running' })
    expect(notices[ID_A]).toEqual({ activity: 'running' })
    notices = runNoticesAfterMessage(notices, { type: 'conversation.run', conversation_id: ID_A, run: null })
    expect(notices[ID_A]).toBeUndefined()
  })

  it('carries the queue position on a queued notice only', () => {
    let notices: RunNotices = {}
    notices = runNoticesAfterMessage(notices, {
      type: 'conversation.run', conversation_id: ID_A, run: 'queued', queue_position: 2,
    })
    expect(notices[ID_A]).toEqual({ activity: 'queued', queuePosition: 2 })
    // The run gets its slot: the server sends `running` with no position, and
    // the stale `#2` must not ride along in the fold.
    notices = runNoticesAfterMessage(notices, { type: 'conversation.run', conversation_id: ID_A, run: 'running' })
    expect(notices[ID_A]).toEqual({ activity: 'running' })
  })

  it('returns the same map for an identical notice', () => {
    const notices: RunNotices = { [ID_A]: { activity: 'running' } }
    const same = runNoticesAfterMessage(notices, { type: 'conversation.run', conversation_id: ID_A, run: 'running' })
    expect(same).toBe(notices)
  })

  it('passes every other socket message through untouched', () => {
    const notices: RunNotices = { [ID_A]: { activity: 'running' } }
    expect(
      runNoticesAfterMessage(notices, {
        type: 'stream.end', conversation_id: ID_A, stream_id: 's1', seq: 3, status: 'complete',
      }),
    ).toBe(notices)
  })

  it('treats null for an unknown conversation as no change', () => {
    const notices: RunNotices = {}
    expect(runNoticesAfterMessage(notices, { type: 'conversation.run', conversation_id: ID_A, run: null })).toBe(notices)
  })
})

describe('withoutRunNotice', () => {
  it('drops a deleted conversation’s notice and leaves the rest', () => {
    const notices: RunNotices = { [ID_A]: { activity: 'running' }, [ID_B]: { activity: 'queued', queuePosition: 1 } }
    const next = withoutRunNotice(notices, ID_A)
    expect(ID_A in next).toBe(false)
    expect(next[ID_B]).toEqual({ activity: 'queued', queuePosition: 1 })
    expect(withoutRunNotice(next, 'missing-id')).toBe(next)
  })
})

describe('threadRunBadges', () => {
  it('labels each state in the header’s words, with the queue place', () => {
    const notices: RunNotices = {
      [ID_A]: { activity: 'running' },
      [ID_B]: { activity: 'queued', queuePosition: 2 },
    }
    const badges = threadRunBadges(notices, null)
    expect(badges[ID_A]).toMatchObject({ state: 'running', label: 'Running', dot: 'bg-primary' })
    expect(badges[ID_B]).toMatchObject({ state: 'queued', label: 'Queued · #2', dot: 'bg-warning' })
  })

  it('overlays the local stopping acknowledgement and outranks the notice', () => {
    const notices: RunNotices = { [ID_A]: { activity: 'awaiting_approval' } }
    const badges = threadRunBadges(notices, ID_A)
    // Asked to stop while parked on an approval: the row says what the user
    // did; the run really is still winding down either way (#113).
    expect(badges[ID_A]).toMatchObject({ state: 'stopping', label: 'Stopping…' })
  })

  it('shows stopping on a row with no notice at all, and nowhere else', () => {
    // An older server never answers the watch; the Stop the user just pressed
    // is still worth acknowledging on the row they acted on.
    const badges = threadRunBadges({}, ID_A)
    expect(badges[ID_A]).toMatchObject({ state: 'stopping' })
    expect(Object.keys(badges)).toEqual([ID_A])
  })

  it('is the empty object when there is nothing to say', () => {
    expect(threadRunBadges({}, null)).toEqual({})
  })
})

describe('runNoticesWithin', () => {
  it('forgets a notice whose row left the watch', () => {
    // The server forgets it too, and its next reply names only busy rows, so
    // a notice kept here could never be corrected once the run ended off-list.
    const notices: RunNotices = { [ID_A]: { activity: 'running' }, [ID_B]: { activity: 'queued', queuePosition: 2 } }
    expect(runNoticesWithin(notices, [ID_B])).toEqual({ [ID_B]: { activity: 'queued', queuePosition: 2 } })
  })
  it('returns the same map when every notice is still watched', () => {
    const notices: RunNotices = { [ID_A]: { activity: 'running' } }
    expect(runNoticesWithin(notices, [ID_A, ID_B])).toBe(notices)
  })
})

describe('rowsNoLongerLive', () => {
  it('names the rows whose badge went away, and only those', () => {
    expect(rowsNoLongerLive([ID_A, ID_B], { [ID_B]: {} })).toEqual([ID_A])
    expect(rowsNoLongerLive([], { [ID_A]: {} })).toEqual([])
  })
})

describe('routineRecordCheck', () => {
  it('keeps asking while the record still says running with no live badge', () => {
    expect(routineRecordCheck(new Set([ID_A]), { [ID_A]: { status: 'running' } }, {})).toEqual({ settled: [], stale: [ID_A] })
  })
  it('settles once the record moves on, the row goes, or the badge is back', () => {
    expect(routineRecordCheck(new Set([ID_A]), { [ID_A]: { status: 'complete' } }, {}).settled).toEqual([ID_A])
    expect(routineRecordCheck(new Set([ID_A]), {}, {}).settled).toEqual([ID_A])
    expect(routineRecordCheck(new Set([ID_A]), { [ID_A]: { status: 'running' } }, { [ID_A]: {} }).settled).toEqual([ID_A])
  })
})
