import { describe, expect, it } from 'vitest'
import { runStatusIsError, runStatusLabel, runTimeLabel } from './routineRuns'

/**
 * Every chat a routine makes carries the same title, so these two labels are
 * the only thing distinguishing one row of its history from another.
 */
describe('runStatusLabel', () => {
  it('reads as an outcome rather than a column value', () => {
    expect(runStatusLabel('completed')).toBe('Done')
    expect(runStatusLabel('failed')).toBe('Failed')
    expect(runStatusLabel('running')).toBe('Running')
    // A user pressed stop. Not a failure, and saying so would be an
    // accusation about something they chose.
    expect(runStatusLabel('cancelled')).toBe('Stopped')
  })

  it('passes an unrecognised status through rather than inventing one', () => {
    // A plain text column: a newer server may write a status this build has
    // never heard of, and "unknown" would be less true than the word itself.
    expect(runStatusLabel('queued')).toBe('queued')
  })

  it('treats only a failure as a problem', () => {
    expect(runStatusIsError('failed')).toBe(true)
    expect(runStatusIsError('cancelled')).toBe(false)
    expect(runStatusIsError('completed')).toBe(false)
  })
})

describe('runTimeLabel', () => {
  const now = new Date('2026-09-20T12:00:00Z').getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('is relative within the day, when that is the question being asked', () => {
    expect(runTimeLabel(ago(30_000), now)).toBe('Just now')
    expect(runTimeLabel(ago(5 * 60_000), now)).toBe('5m ago')
    expect(runTimeLabel(ago(3 * 3_600_000), now)).toBe('3h ago')
  })

  it('becomes a date once "N ago" stops being an answer', () => {
    const label = runTimeLabel(ago(9 * 24 * 3_600_000), now)
    expect(label).not.toContain('ago')
    expect(label).toContain('11')
  })

  it('floors rather than rounds, so nothing reads as older than it is', () => {
    // 59 minutes rounded is "1h ago" for a run that has not been going an
    // hour. Floors keep the label a lower bound.
    expect(runTimeLabel(ago(59 * 60_000), now)).toBe('59m ago')
  })

  it('says "Just now" for a clock that is behind the server', () => {
    expect(runTimeLabel(new Date(now + 60_000).toISOString(), now)).toBe('Just now')
  })

  it('renders nothing for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(runTimeLabel('not a date', now)).toBe('')
  })
})
