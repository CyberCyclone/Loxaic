import {
  isServerNote,
  parseProgressNote,
  settledRunReviews,
  withRunReview,
  type ReviewMode,
  type RunReview,
  type RunReviewDetail,
  type StreamEventKind,
  type StreamSnapshot,
  type StreamStatus,
} from '@loxaic/api-client';
import { displayModelRef } from '@loxaic/types';
import { formatTokens } from '@/lib/promptStats';
import { formatDuration } from '@/lib/subAgents';

/**
 * The progress review, as the client shows it: a second model call the server
 * makes every so often to decide whether a run is stuck. Nobody is asked
 * anything; the client only says a review is under way, and what a review
 * wrote into the thread.
 */

/** The quiet line under a run while a review of it is under way; null when
 * none is. */
export function reviewStatusText(mode: ReviewMode | null | undefined): string | null {
  if (mode === 'alongside') return 'Checking progress…';
  if (mode === 'paused') return 'Paused to check progress…';
  return null;
}

/** A review under way, after one live event: started, ended, or untouched. */
export function reviewingAfterEvent(prev: ReviewMode | null, event: StreamEventKind): ReviewMode | null {
  if (event.kind === 'run.review.start') return event.mode;
  if (event.kind === 'run.review.end') return null;
  return prev;
}

const NOTE_OUTCOME: Record<NonNullable<ReturnType<typeof parseProgressNote>>['action'], string> = {
  steer: 'Told to change approach',
  answer: 'Told to answer now',
  ended: 'Ended without an answer',
};

type NoteAction = NonNullable<ReturnType<typeof parseProgressNote>>['action'];

/** A progress note, as the transcript shows it: the reviewer's reason, and
 * what the run was told. Never what the note carried over from a reply it cut
 * short: that is thousands of characters of the run's own thinking, there for
 * the model's next request and not for a reader. Null for anything else —
 * including the same words typed by a person, which are that person's message
 * and shown as one. */
export function progressNoteView(msg: { text: string; authorUserId?: string | null }): { reason: string; outcome: string; action: NoteAction } | null {
  const note = isServerNote(msg.text, msg.authorUserId) ? parseProgressNote(msg.text) : null;
  if (!note) return null;
  return {
    reason: `Progress check: ${note.reason}`,
    outcome: NOTE_OUTCOME[note.action],
    action: note.action,
  };
}

/**
 * The notes whose second line ("Told to change approach") a card in the
 * thread already says, by index into `msgs`: those show the reason alone.
 *
 * A note's card is the newest review before it that told the run anything,
 * when that review told it this, its card is on the page (some loaded message
 * is at or before it) and no earlier note has it already: a review writes one
 * note. A note with no card keeps its line: one from a server that sent no
 * reviews, and the one that ended a run which never answered, which no
 * review's card says.
 */
export function notesSaidByCards(
  msgs: readonly { lamport?: number; role?: string; text: string; authorUserId?: string | null }[],
  reviews: readonly RunReview[],
): Set<number> {
  const said = new Set<number>();
  if (reviews.length === 0) return said;
  const oldest = msgs.find((m) => m.lamport !== undefined)?.lamport;
  const claimed = new Set<string>();
  msgs.forEach((m, i) => {
    const at = m.lamport;
    if (at === undefined || oldest === undefined || m.role !== 'user') return;
    const note = progressNoteView(m);
    if (!note || note.action === 'ended') return;
    const card = reviews
      .filter((r) => r.lamport < at && (r.action === 'steer' || r.action === 'answer'))
      .reduce<RunReview | undefined>((newest, r) => (newest && newest.lamport > r.lamport ? newest : r), undefined);
    if (card?.action !== note.action || card.lamport < oldest || claimed.has(card.id)) return;
    claimed.add(card.id);
    said.add(i);
  });
  return said;
}

// ── Review cards ───────────────────────────────────────────────────────────
//
// Every review is a card in the thread, where it happened, built from its
// record: live from `run.review.*` and a snapshot's `reviews`, and after a
// reload from `GET /v1/conversations/:id/reviews`. A list here is one
// conversation's, in thread order.

/** A review that has not ended. */
export function isReviewRunning(review: RunReview): boolean {
  return review.ended_at === undefined;
}

/** One conversation's cards after a live event. */
export function reviewsAfterEvent(list: readonly RunReview[], event: StreamEventKind): readonly RunReview[] {
  if ((event.kind === 'run.review.start' || event.kind === 'run.review.end') && event.review) {
    return withRunReview(list, event.review);
  }
  return list;
}

/**
 * One conversation's cards after a run's snapshot: the snapshot's own put in
 * (each replaces the copy held). A run that has ended has no review under
 * way, whatever was held: one of its cards still running was never finished
 * and goes.
 */
export function reviewsAfterSnapshot(
  list: readonly RunReview[],
  streamId: string,
  snapshot: Pick<StreamSnapshot, 'reviews'>,
  status: StreamStatus,
): readonly RunReview[] {
  const active = status === 'active';
  const theirs = active ? (snapshot.reviews ?? []) : settledRunReviews(snapshot.reviews ?? []);
  const kept = active ? list : list.filter((r) => !(r.stream_id === streamId && isReviewRunning(r)));
  if (theirs.length === 0) return kept.length === list.length ? list : kept;
  return theirs.reduce<readonly RunReview[]>((acc, review) => withRunReview(acc, review), kept);
}

/** One conversation's cards after a run ended: what it had under way never
 * finished (a run that ends mid-review says nothing more). */
export function reviewsAfterEnd(list: readonly RunReview[], streamId: string): readonly RunReview[] {
  const kept = list.filter((r) => !(r.stream_id === streamId && isReviewRunning(r)));
  return kept.length === list.length ? list : kept;
}

/**
 * One conversation's cards after its stored listing arrived. The listing is
 * the truth about everything finished (a rewind removes records, so a card
 * held and not listed is gone), with two exceptions it cannot know of: a
 * review still under way, which is in no listing, and one the stream told of
 * after the listing was asked for (`heardSince`), which may have ended after
 * the server read its table.
 */
export function withListedReviews(
  list: readonly RunReview[],
  listed: readonly RunReview[],
  heardSince: ReadonlySet<string> = new Set(),
): readonly RunReview[] {
  const ids = new Set(listed.map((r) => r.id));
  return list
    .filter((r) => !ids.has(r.id) && (isReviewRunning(r) || heardSince.has(r.id)))
    .reduce<readonly RunReview[]>((acc, review) => withRunReview(acc, review), listed);
}

/**
 * Which message each card sits under: the newest one at or before the
 * review's place in the thread (`lamport`), by index into `msgs`. A message
 * with no lamport (an optimistic bubble) anchors nothing. A review older than
 * everything loaded has no message to sit under yet and is left out until
 * its page is.
 */
export function reviewsByMessage(
  msgs: readonly { lamport?: number }[],
  reviews: readonly RunReview[],
): Map<number, RunReview[]> {
  const placed = new Map<number, RunReview[]>();
  for (const review of reviews) {
    let at = -1;
    msgs.forEach((m, i) => {
      if (m.lamport !== undefined && m.lamport <= review.lamport) at = i;
    });
    if (at < 0) continue;
    const under = placed.get(at);
    if (under) under.push(review);
    else placed.set(at, [review]);
  }
  return placed;
}

/** The quiet line stays for a review an older server sent no card for. */
export function reviewLineMode(
  reviewing: ReviewMode | null | undefined,
  reviews: readonly RunReview[] | null | undefined,
): ReviewMode | null {
  if (!reviewing) return null;
  return (reviews ?? []).some(isReviewRunning) ? null : reviewing;
}

const DONE: Record<NonNullable<RunReview['action']>, string | null> = {
  none: null,
  steer: 'told to change approach',
  answer: 'told to answer',
};

/** What was done about a review, as a sentence; for its panel. */
export function reviewActionText(review: Pick<RunReview, 'action' | 'verdict'>): string {
  if (review.action === 'steer') return 'Told to change approach';
  if (review.action === 'answer') return 'Told to stop and answer';
  // A verdict that called for something and did nothing: its owner turned
  // reviews off for this conversation while it ran.
  return review.verdict === 'stuck' || review.verdict === 'finished' ? 'Nothing: reviews were turned off' : 'Nothing: the run carried on';
}

/** What a review found, in a word or two. */
export function reviewVerdictText(review: Pick<RunReview, 'verdict' | 'forced'>): string {
  if (review.forced) return 'time limit reached';
  return review.verdict ?? 'no verdict';
}

/**
 * A review's card: under way ("Checking progress…"), or what it found and
 * what was done ("Progress check · stuck · told to change approach"). The
 * second line is where in the run it was taken.
 */
export function reviewCardView(review: RunReview): { running: boolean; title: string; meta: string } {
  const meta = `Step ${String(review.step)} · ${formatDuration(review.worked_ms)} of work`;
  if (isReviewRunning(review)) {
    return { running: true, title: reviewStatusText(review.mode) ?? 'Checking progress…', meta };
  }
  const done = review.action ? DONE[review.action] : null;
  return {
    running: false,
    title: ['Progress check', reviewVerdictText(review), ...(done ? [done] : [])].join(' · '),
    meta,
  };
}

const MODE_TEXT: Record<ReviewMode, string> = {
  alongside: 'Beside the run, on a spare inference slot',
  paused: 'The run paused and lent it its own inference slot',
};

const TRIGGER_TEXT: Record<RunReview['trigger'], string> = {
  steps: 'Enough steps since the last check',
  time: 'Enough working time since the last check',
  'in-reply': 'One reply had written a lot without acting',
  limit: 'The working-time limit of a run nobody is watching',
};

export interface ReviewPanelRow {
  /** The row's testID suffix, `review.panel.<key>`. */
  key: string;
  label: string;
  value: string;
}

/**
 * The panel's rows, top to bottom. `detail` is the full record once it has
 * loaded; until then the rows the card already knows are shown. A figure the
 * backend did not report is left out, never shown as 0.
 */
export function reviewPanelRows(review: RunReview, detail: RunReviewDetail | null): ReviewPanelRow[] {
  const rows: ReviewPanelRow[] = [];
  const running = isReviewRunning(review);
  if (running) {
    rows.push({ key: 'verdict', label: 'Verdict', value: 'Still checking…' });
  } else {
    rows.push({ key: 'verdict', label: 'Verdict', value: reviewVerdictText(review) });
    if (review.reason) rows.push({ key: 'reason', label: 'Reason', value: review.reason });
    rows.push({ key: 'action', label: 'What was done', value: reviewActionText(review) });
  }
  if (review.mode) rows.push({ key: 'mode', label: 'How it ran', value: MODE_TEXT[review.mode] });
  rows.push({ key: 'trigger', label: 'Why now', value: TRIGGER_TEXT[review.trigger] });
  rows.push({ key: 'step', label: 'Step', value: String(review.step) });
  rows.push({ key: 'worked', label: 'Working time', value: formatDuration(review.worked_ms) });
  if (!detail) return rows;
  if (detail.model) rows.push({ key: 'model', label: 'Model', value: displayModelRef(detail.model) });
  if (detail.input_tokens !== null) {
    rows.push({
      key: 'input',
      label: 'Input size',
      value:
        detail.output_tokens !== null
          ? `${formatTokens(detail.input_tokens)} tokens in, ${formatTokens(detail.output_tokens)} out`
          : `${formatTokens(detail.input_tokens)} tokens`,
    });
  }
  if (detail.prompt_ms !== null) rows.push({ key: 'promptTime', label: 'Prompt processing', value: formatDuration(detail.prompt_ms) });
  if (detail.generation_ms !== null) rows.push({ key: 'generationTime', label: 'Generation', value: formatDuration(detail.generation_ms) });
  // The ceiling asked no model: there is no request to time.
  if (detail.total_ms !== null && detail.model) rows.push({ key: 'total', label: 'Took', value: formatDuration(detail.total_ms) });
  return rows;
}

/**
 * The reviewer-instructions editor's draft: the text being edited, beside
 * what the server holds (`saved`, null for the built-in instructions) and the
 * built-in text it falls back to.
 */
export interface ReviewPromptDraft {
  /** What the input shows. */
  text: string;
  /** What the input showed when the draft last matched the server. */
  baseline: string;
}

/** What the input shows for a saved value: the user's own, or the built-in. */
export function promptShown(saved: string | null | undefined, builtIn: string | undefined): string {
  return saved ?? builtIn ?? '';
}

export function reviewPromptDraft(saved: string | null | undefined, builtIn: string | undefined): ReviewPromptDraft {
  const shown = promptShown(saved, builtIn);
  return { text: shown, baseline: shown };
}

/**
 * The draft after the server's value changed (a save landed, another device
 * saved, a reload). Follows the server whenever nothing has been typed over
 * it; keeps what someone is typing otherwise — the `followSaved` rule of
 * lib/sandboxAllocation.ts.
 */
export function followSavedPrompt(
  draft: ReviewPromptDraft,
  saved: string | null | undefined,
  builtIn: string | undefined,
): ReviewPromptDraft {
  const shown = promptShown(saved, builtIn);
  return { text: draft.text === draft.baseline ? shown : draft.text, baseline: shown };
}

/**
 * Where the editor stands. `blank` refuses a save: the server does too, and
 * Reset is the way back to the built-in instructions. `tooLong` likewise.
 */
export function reviewPromptState(
  draft: ReviewPromptDraft,
  maxChars: number,
): 'unchanged' | 'unsaved' | 'blank' | 'tooLong' {
  if (draft.text === draft.baseline) return 'unchanged';
  if (draft.text.trim() === '') return 'blank';
  if (draft.text.length > maxChars) return 'tooLong';
  return 'unsaved';
}

/** The line under the editor. `justSaved` is whether the last thing that
 * happened was a save landing. */
export function reviewPromptStateLine(
  state: ReturnType<typeof reviewPromptState>,
  justSaved: boolean,
  maxChars: number,
): string | null {
  switch (state) {
    case 'unsaved':
      return 'Unsaved changes';
    case 'blank':
      return 'The instructions cannot be empty. Use Reset to go back to the built-in ones.';
    case 'tooLong':
      return `Too long: at most ${maxChars.toLocaleString('en-US')} characters.`;
    default:
      return justSaved ? 'Saved' : null;
  }
}
