/**
 * How a routine's runs are labelled in a list.
 *
 * Pure and separate from the components so both labels can be tested without a
 * React Native environment. They matter more than they look: a routine's chats
 * all share one title (`Routine: <name>`), so in the history list the run's
 * own time and status are the *only* things telling one row from another.
 */

/** A run's status as a word for a badge. Unknown values are passed through —
 * this is a plain text column, and inventing "unknown" for a status a newer
 * server added would be worse than showing it. */
export function runStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Stopped'
    default:
      return status
  }
}

/** Whether this status should be shown as a problem rather than a fact. */
export function runStatusIsError(status: string): boolean {
  return status === 'failed'
}

/**
 * When a run started, as a row label.
 *
 * Relative for anything inside a day, because that is the question being asked
 * of a recent run ("is this the one that just went?"), and an absolute date
 * beyond it, because "9d ago" stops being an answer.
 */
export function runTimeLabel(startedAt: string, now: number = Date.now()): string {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return ''
  const mins = Math.floor((now - started) / 60000)
  // A clock that is behind the server's reads as a run in the future; "just
  // now" is the least wrong thing to say about it.
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${String(mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return new Date(startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
