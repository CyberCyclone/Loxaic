import { isServerNote, parseProgressNote, type ReviewMode, type StreamEventKind } from '@loxaic/api-client';

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

/** A progress note, as the transcript shows it: the reviewer's reason, and
 * what the run was told. Null for anything else — including the same words
 * typed by a person, which are that person's message and shown as one. */
export function progressNoteView(msg: { text: string; authorUserId?: string | null }): { reason: string; outcome: string } | null {
  const note = isServerNote(msg.text, msg.authorUserId) ? parseProgressNote(msg.text) : null;
  if (!note) return null;
  return {
    reason: `Progress check: ${note.reason}`,
    outcome: note.action === 'steer' ? 'Told to change approach' : 'Told to answer now',
  };
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
