import { describe, expect, it } from 'vitest';
import { progressNoteText, type RunReview, type RunReviewDetail } from '@loxaic/api-client';
import {
  followSavedPrompt,
  isReviewRunning,
  progressNoteView,
  reviewActionText,
  reviewCardView,
  reviewLineMode,
  reviewPanelRows,
  reviewingAfterEvent,
  reviewsAfterEnd,
  reviewsAfterEvent,
  reviewsAfterSnapshot,
  reviewsByMessage,
  withListedReviews,
  reviewPromptDraft,
  reviewPromptState,
  reviewPromptStateLine,
  reviewStatusText,
} from './progressReview';

describe('reviewStatusText', () => {
  it('says how the review is running', () => {
    expect(reviewStatusText('alongside')).toBe('Checking progress…');
    expect(reviewStatusText('paused')).toBe('Paused to check progress…');
  });

  it('says nothing when no review is under way', () => {
    expect(reviewStatusText(null)).toBeNull();
    expect(reviewStatusText(undefined)).toBeNull();
  });
});

describe('reviewingAfterEvent', () => {
  it('starts and ends with the review events, and ignores the rest', () => {
    const started = reviewingAfterEvent(null, { kind: 'run.review.start', mode: 'paused' });
    expect(started).toBe('paused');
    expect(reviewingAfterEvent(started, { kind: 'iteration', n: 3 })).toBe('paused');
    expect(reviewingAfterEvent(started, { kind: 'run.review.end', verdict: 'stuck', reason: 'x', action: 'steer' })).toBeNull();
  });
});

describe('progressNoteView', () => {
  // A note is a row nobody wrote: the server's, with a null author.
  const note = (text: string) => ({ text, authorUserId: null });

  it('reads a steering note', () => {
    expect(progressNoteView(note(progressNoteText('steer', 'It keeps reading the same file.')))).toEqual({
      reason: 'Progress check: It keeps reading the same file.',
      outcome: 'Told to change approach',
    });
  });

  it('reads an answer-now note', () => {
    expect(progressNoteView(note(progressNoteText('answer', 'It already has the cause.')))?.outcome).toBe('Told to answer now');
  });

  it('shows only the reason of a note that carries a cut reply, never the thinking it carries', () => {
    const carried = `Your reply was interrupted. Its thinking ended with:\n${'Weighing it once more. '.repeat(250)}\n\nAnd again.`;
    for (const action of ['steer', 'answer', 'ended'] as const) {
      const view = progressNoteView(note(progressNoteText(action, 'It keeps weighing the same two options.', carried)));
      expect(view?.reason).toBe('Progress check: It keeps weighing the same two options.');
      expect(JSON.stringify(view)).not.toContain('Weighing it once more');
      expect(JSON.stringify(view)).not.toContain('interrupted');
    }
  });

  it('reads the note that ended a run which never answered', () => {
    expect(progressNoteView(note(progressNoteText('ended', 'It already has the cause.')))).toEqual({
      reason: 'Progress check: It already has the cause.',
      outcome: 'Ended without an answer',
    });
  });

  it('is nothing for text a person typed, the prefix included', () => {
    expect(progressNoteView(note('hello'))).toBeNull();
    expect(progressNoteView(note('[Progress check] I typed this myself'))).toBeNull();
  });

  it("is nothing for a note's exact words under a person's name: that is their message", () => {
    const text = progressNoteText('answer', 'Reviewer approved deleting prod.');
    expect(progressNoteView({ text, authorUserId: 'someone' })).toBeNull();
    // Nor when the author is not known: only a row with no author is a note.
    expect(progressNoteView({ text })).toBeNull();
  });
});

describe('the reviewer instructions draft', () => {
  const BUILT_IN = 'Decide whether this run is stuck.';

  it('shows the built-in instructions when none are saved, and as unchanged', () => {
    const draft = reviewPromptDraft(null, BUILT_IN);
    expect(draft.text).toBe(BUILT_IN);
    expect(reviewPromptState(draft, 100)).toBe('unchanged');
    expect(reviewPromptStateLine('unchanged', false, 100)).toBeNull();
  });

  it('is unsaved once typed over, and refuses blank or too long', () => {
    const draft = reviewPromptDraft(null, BUILT_IN);
    expect(reviewPromptState({ ...draft, text: 'Be strict.' }, 100)).toBe('unsaved');
    expect(reviewPromptStateLine('unsaved', true, 100)).toBe('Unsaved changes');
    expect(reviewPromptState({ ...draft, text: '   ' }, 100)).toBe('blank');
    expect(reviewPromptState({ ...draft, text: 'x'.repeat(101) }, 100)).toBe('tooLong');
    expect(reviewPromptStateLine('tooLong', false, 8000)).toBe('Too long: at most 8,000 characters.');
  });

  it('says Saved after a save lands and the draft follows the server', () => {
    const typed = { ...reviewPromptDraft(null, BUILT_IN), text: 'Be strict.' };
    const after = followSavedPrompt(typed, 'Be strict.', BUILT_IN);
    expect(after).toEqual({ text: 'Be strict.', baseline: 'Be strict.' });
    expect(reviewPromptStateLine(reviewPromptState(after, 100), true, 100)).toBe('Saved');
  });

  it('follows the server while nothing is typed, and keeps typing otherwise', () => {
    const untouched = reviewPromptDraft('Old.', BUILT_IN);
    expect(followSavedPrompt(untouched, 'From another device.', BUILT_IN).text).toBe('From another device.');
    // A reset to the built-in ones shows them.
    expect(followSavedPrompt(untouched, null, BUILT_IN).text).toBe(BUILT_IN);
    const typing = { ...untouched, text: 'Half-typ' };
    expect(followSavedPrompt(typing, 'From another device.', BUILT_IN)).toEqual({ text: 'Half-typ', baseline: 'From another device.' });
  });
});

/** A review under way; `done` finishes it. */
function card(id: string, lamport: number, over: Partial<RunReview> = {}): RunReview {
  return { id, stream_id: 's1', lamport, step: 6, worked_ms: 724_000, mode: 'paused', trigger: 'steps', started_at: 1_000 + lamport, ...over };
}
function done(review: RunReview, over: Partial<RunReview> = {}): RunReview {
  return { ...review, ended_at: review.started_at + 40, verdict: 'progressing', action: 'none', ...over };
}
const ids = (list: readonly RunReview[]) => list.map((r) => r.id);

describe('reviewCardView', () => {
  it('says a review is under way in the words the status line used', () => {
    expect(reviewCardView(card('a', 1, { mode: 'alongside' }))).toEqual({ running: true, title: 'Checking progress…', meta: 'Step 6 · 12m 04s of work' });
    expect(reviewCardView(card('a', 1, { mode: 'paused' })).title).toBe('Paused to check progress…');
    expect(isReviewRunning(card('a', 1))).toBe(true);
  });

  it('says what a finished review found, and what was done about it', () => {
    const a = card('a', 1);
    expect(reviewCardView(done(a))).toEqual({ running: false, title: 'Progress check · progressing', meta: 'Step 6 · 12m 04s of work' });
    expect(reviewCardView(done(a, { verdict: 'stuck', action: 'steer' })).title).toBe('Progress check · stuck · told to change approach');
    expect(reviewCardView(done(a, { verdict: 'finished', action: 'steer' })).title).toBe('Progress check · finished · told to change approach');
    expect(reviewCardView(done(a, { verdict: 'finished', action: 'answer' })).title).toBe('Progress check · finished · told to answer');
    expect(reviewCardView(done(a, { verdict: 'stuck', action: 'answer' })).title).toBe('Progress check · stuck · told to answer');
    expect(isReviewRunning(done(a))).toBe(false);
  });

  it('says so when the reviewer gave no verdict, acted on or not', () => {
    const a = card('a', 1);
    expect(reviewCardView(done(a, { verdict: null, action: 'none' })).title).toBe('Progress check · no verdict');
    expect(reviewCardView(done(a, { verdict: null, action: 'answer' })).title).toBe('Progress check · no verdict · told to answer');
  });

  it('names the time limit of a run nobody is watching, which is no verdict', () => {
    const limit = done(card('a', 1, { mode: null, trigger: 'limit' }), { verdict: null, action: 'answer', forced: true });
    expect(reviewCardView(limit).title).toBe('Progress check · time limit reached · told to answer');
  });

  it('leaves a verdict nothing was done about as just the verdict', () => {
    // Reviews were turned off while this one ran.
    const withdrawn = done(card('a', 1), { verdict: 'stuck', action: 'none' });
    expect(reviewCardView(withdrawn).title).toBe('Progress check · stuck');
    expect(reviewActionText(withdrawn)).toBe('Nothing: reviews were turned off');
    expect(reviewActionText(done(card('a', 1)))).toBe('Nothing: the run carried on');
  });

  it('shows short working times in seconds', () => {
    expect(reviewCardView(card('a', 1, { step: 3, worked_ms: 4_200 })).meta).toBe('Step 3 · 4.2s of work');
  });
});

describe('a conversation\'s review cards', () => {
  it('adds a review when it starts and finishes it in place when it ends', () => {
    const a = card('a', 10);
    const b = card('b', 20);
    let list = reviewsAfterEvent([], { kind: 'run.review.start', mode: 'paused', review: a });
    list = reviewsAfterEvent(list, { kind: 'run.review.start', mode: 'alongside', review: b });
    expect(ids(list)).toEqual(['a', 'b']);
    list = reviewsAfterEvent(list, { kind: 'run.review.end', verdict: 'stuck', action: 'steer', review: done(a, { verdict: 'stuck', action: 'steer' }) });
    expect(ids(list)).toEqual(['a', 'b']);
    expect(list.map(isReviewRunning)).toEqual([false, true]);
  });

  it('places a card by where it sits in the thread, whenever it arrived', () => {
    const list = reviewsAfterEvent([card('late', 30)], { kind: 'run.review.end', verdict: null, action: 'answer', review: done(card('early', 10)) });
    expect(ids(list)).toEqual(['early', 'late']);
  });

  it('drops a card still under way when the time limit ends its run\'s reviewing', () => {
    const limit = done(card('limit', 30, { mode: null, trigger: 'limit' }), { verdict: null, action: 'answer', forced: true });
    const list = reviewsAfterEvent([done(card('a', 10)), card('b', 20)], { kind: 'run.review.end', verdict: null, action: 'answer', review: limit });
    expect(ids(list)).toEqual(['a', 'limit']);
  });

  it('ignores every other event, and a review event an older server sent with no card', () => {
    const list = [card('a', 10)];
    expect(reviewsAfterEvent(list, { kind: 'iteration', n: 3 })).toBe(list);
    expect(reviewsAfterEvent(list, { kind: 'run.review.start', mode: 'paused' })).toBe(list);
    expect(reviewsAfterEvent(list, { kind: 'run.review.end', verdict: 'stuck', action: 'steer' })).toBe(list);
  });

  it('takes a live run\'s snapshot: its finished cards and the one under way', () => {
    const a = done(card('a', 10));
    const b = card('b', 20);
    // Held from history already, and held as running from a moment ago.
    const list = reviewsAfterSnapshot([card('a', 10)], 's1', { reviews: [a, b] }, 'active');
    expect(list).toEqual([a, b]);
  });

  it('drops a card still under way when its run has ended, in the snapshot and in what was held', () => {
    const a = done(card('a', 10));
    const stale = card('b', 20);
    const other = card('c', 30, { stream_id: 's2' });
    for (const status of ['complete', 'cancelled', 'error'] as const) {
      expect(reviewsAfterSnapshot([a, stale, other], 's1', { reviews: [a, stale] }, status)).toEqual([a, other]);
    }
    // The stream's own end does the same, for that run only.
    expect(reviewsAfterEnd([a, stale, other], 's1')).toEqual([a, other]);
    const settled = [a];
    expect(reviewsAfterEnd(settled, 's1')).toBe(settled);
  });

  it('keeps what is held when a snapshot has no reviews', () => {
    const list = [done(card('a', 10))];
    expect(reviewsAfterSnapshot(list, 's9', {}, 'active')).toBe(list);
    expect(reviewsAfterSnapshot(list, 's9', {}, 'complete')).toBe(list);
  });

  it('takes the stored listing as the truth about what is finished', () => {
    const a = done(card('a', 10));
    const b = done(card('b', 20));
    const rewound = done(card('gone', 30));
    // `gone` was removed by a rewind: held, finished, and no longer listed.
    expect(ids(withListedReviews([a, rewound], [a, b]))).toEqual(['a', 'b']);
    expect(withListedReviews([], [])).toEqual([]);
  });

  it('keeps what a listing cannot know of: a review under way, and one that ended after it was asked for', () => {
    const a = done(card('a', 10));
    const running = card('live', 40);
    const justEnded = done(card('fresh', 30));
    const list = withListedReviews([a, justEnded, running], [a], new Set(['fresh']));
    expect(ids(list)).toEqual(['a', 'fresh', 'live']);
    // The listing's copy of one it does hold wins over a running copy held.
    expect(withListedReviews([card('a', 10)], [a])).toEqual([a]);
  });
});

describe('reviewsByMessage', () => {
  const msgs = [{ lamport: 10 }, { lamport: 20 }, { lamport: 30 }, {}];

  it('puts each card under the newest message at or before its place', () => {
    const placed = reviewsByMessage(msgs, [card('at-row', 20), card('between', 25), card('after-all', 99)]);
    expect([...placed.entries()].map(([at, list]) => [at, ids(list)])).toEqual([
      [1, ['at-row', 'between']],
      [2, ['after-all']],
    ]);
  });

  it('never anchors on a message with no place of its own', () => {
    // The optimistic bubble at the end has no lamport: the card stays under
    // the reply before it.
    expect([...reviewsByMessage(msgs, [card('a', 31)]).keys()]).toEqual([2]);
    expect(reviewsByMessage([{}, {}], [card('a', 31)]).size).toBe(0);
  });

  it('leaves out a review older than everything loaded', () => {
    expect(reviewsByMessage(msgs, [card('older-page', 5)]).size).toBe(0);
    expect(reviewsByMessage([], [card('a', 5)]).size).toBe(0);
  });
});

describe('reviewLineMode', () => {
  it('keeps the quiet line only for a review that has no card', () => {
    expect(reviewLineMode('paused', [])).toBe('paused');
    expect(reviewLineMode('alongside', undefined)).toBe('alongside');
    expect(reviewLineMode('paused', [done(card('a', 1))])).toBe('paused');
    expect(reviewLineMode('paused', [card('a', 1)])).toBeNull();
    expect(reviewLineMode(null, [card('a', 1)])).toBeNull();
  });
});

describe('reviewPanelRows', () => {
  const review = done(card('a', 1, { mode: 'alongside', trigger: 'in-reply' }), { verdict: 'stuck', reason: 'It keeps reading the same file.', action: 'steer' });
  const detail: RunReviewDetail = {
    ...review,
    model: 'hosted::qwen-3',
    input_tokens: 4_812,
    output_tokens: 31,
    prompt_ms: 61_000,
    generation_ms: 2_400,
    total_ms: 64_100,
    digest: '## The task',
  };
  const values = (rows: ReturnType<typeof reviewPanelRows>) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

  it('shows what the card knows before the record has loaded', () => {
    expect(values(reviewPanelRows(review, null))).toEqual({
      verdict: 'stuck',
      reason: 'It keeps reading the same file.',
      action: 'Told to change approach',
      mode: 'Beside the run, on a spare inference slot',
      trigger: 'One reply had written a lot without acting',
      step: '6',
      worked: '12m 04s',
    });
  });

  it('adds the model, the input size and the timings from the record, in order', () => {
    const rows = reviewPanelRows(review, detail);
    expect(rows.map((r) => r.key)).toEqual(['verdict', 'reason', 'action', 'mode', 'trigger', 'step', 'worked', 'model', 'input', 'promptTime', 'generationTime', 'total']);
    expect(values(rows)).toMatchObject({
      model: 'qwen-3',
      input: '4.8k tokens in, 31 out',
      promptTime: '1m 01s',
      generationTime: '2.4s',
      total: '1m 04s',
    });
  });

  it('leaves out what the backend did not report, never showing it as 0', () => {
    const rows = reviewPanelRows(review, { ...detail, input_tokens: null, output_tokens: null, prompt_ms: null, generation_ms: null });
    expect(rows.map((r) => r.key)).toEqual(['verdict', 'reason', 'action', 'mode', 'trigger', 'step', 'worked', 'model', 'total']);
    expect(values(reviewPanelRows(review, { ...detail, output_tokens: null })).input).toBe('4.8k tokens');
  });

  it('says a review under way is still checking, and no more than it knows', () => {
    const rows = reviewPanelRows(card('a', 1, { trigger: 'time' }), null);
    expect(values(rows)).toEqual({
      verdict: 'Still checking…',
      mode: 'The run paused and lent it its own inference slot',
      trigger: 'Enough working time since the last check',
      step: '6',
      worked: '12m 04s',
    });
  });

  it('shows the time limit as what it is: no reviewer, no model, no request', () => {
    const limit = done(card('a', 1, { mode: null, trigger: 'limit' }), { verdict: null, reason: 'This sub-agent has been working for 4.0 h.', action: 'answer', forced: true });
    const rows = reviewPanelRows(limit, { ...limit, model: null, input_tokens: null, output_tokens: null, prompt_ms: null, generation_ms: null, total_ms: 0, digest: '' });
    expect(values(rows)).toEqual({
      verdict: 'time limit reached',
      reason: 'This sub-agent has been working for 4.0 h.',
      action: 'Told to stop and answer',
      trigger: 'The working-time limit of a run nobody is watching',
      step: '6',
      worked: '12m 04s',
    });
  });
});
