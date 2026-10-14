import { describe, expect, it } from 'vitest'
import { rowRunLabel, STATE_DOT, STATE_LABEL } from './runStateCopy'

/** The thread-list row (#282) and the agent header draw from the same table;
 * these pin the words themselves, because a test elsewhere can only assert
 * "the row says what the header says" once both exist. */
describe('run state copy', () => {
  it('names every state', () => {
    expect(STATE_LABEL).toMatchObject({
      queued: 'Queued',
      running: 'Running',
      awaiting_approval: 'Awaiting approval',
      awaiting_checkin: 'Waiting for you',
      stopping: 'Stopping…',
      done: 'Done',
      error: 'Error',
    })
  })

  it('gives every state a semantic dot colour', () => {
    for (const cls of Object.values(STATE_DOT)) {
      expect(cls).toMatch(/^bg-(primary|warning|success|destructive)$/)
    }
  })

  it('puts the place in line on a queued label, and nowhere else', () => {
    expect(rowRunLabel('queued', 3)).toBe('Queued · #3')
    // No position (an older server, or the snapshot never said): just "Queued".
    expect(rowRunLabel('queued')).toBe('Queued')
    expect(rowRunLabel('queued', 0)).toBe('Queued')
    // A position beside any other state is a stale figure: the word wins.
    expect(rowRunLabel('running', 2)).toBe('Running')
    expect(rowRunLabel('stopping')).toBe('Stopping…')
  })
})
