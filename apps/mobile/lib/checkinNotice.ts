import type { CheckinDecisionNote } from '@loxaic/api-client'

/**
 * What the transcript says about a step check-in that was settled — and, in
 * particular, *who* settled it.
 *
 * The server has always known whether a person pressed "Answer now" or the
 * check-in timed out (`authorUserId` on the row, `by` on the event), and the
 * client used to throw both away and print "You asked for an answer" every
 * time. On a slow backend that sentence met someone returning to their desk
 * to find a run had wrapped itself up — being told they had asked for it.
 * Same bug as an unanswered approval once being reported as a denial.
 *
 * Pure so every row of the wording table is asserted (checkinNotice.test.ts).
 */

/**
 * The notice for the fixed "answer now" instruction row.
 *
 * `authorUserId` is three-valued, and all three mean something:
 * - a string — a person pressed the button (this user, or someone sharing
 *   the conversation);
 * - `null` — nobody did: the check-in timed out;
 * - `undefined` — we were not told (an older server's live event). Absence is
 *   never read as either of the other two, so it gets the one sentence that
 *   claims neither.
 */
export function answerNowNotice(authorUserId: string | null | undefined, currentUserId: string | null | undefined): string {
  if (authorUserId === null) return 'Nobody answered the check-in, so it wrapped up with what it had so far.'
  if (authorUserId === undefined) return 'It was asked to answer with what it had so far.'
  if (currentUserId && authorUserId === currentUserId) return 'You asked for an answer with what it had so far.'
  return 'Someone else in this conversation asked for an answer with what it had so far.'
}

/**
 * The notice for a check-in that nobody answered and that kept going on its
 * own. Null for anything else — a person's decision needs no notice beyond
 * the banner they answered, and a timed-out "answer" is told by the
 * instruction row that follows it.
 *
 * Client-only by design: persisting this as a message would put it in the
 * next prompt and move the history anchor's count, so it comes from the
 * stream log and is simply absent once that has expired.
 */
export function autoContinueNotice(note: CheckinDecisionNote | undefined): string | null {
  if (note?.by !== 'timeout' || note.decision !== 'continue') return null
  const step = note.n != null ? ` at step ${String(note.n)}` : ''
  const count =
    note.unattended != null && note.auto_continues != null && note.auto_continues > 0
      ? ` (${String(note.unattended)} of ${String(note.auto_continues)} before it wraps up)`
      : ''
  return `Nobody answered the check-in${step}, so it kept going${count}.`
}
