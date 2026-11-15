/**
 * What the transcript says about a step check-in that was settled — and, in
 * particular, *who* settled it. Check-ins are gone (the progress review
 * replaced them), but their rows stay in old threads and still render.
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
