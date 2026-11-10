import { describe, expect, it } from 'vitest';
import { progressNoteText } from '@loxaic/api-client';
import {
  followSavedPrompt,
  progressNoteView,
  reviewingAfterEvent,
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
