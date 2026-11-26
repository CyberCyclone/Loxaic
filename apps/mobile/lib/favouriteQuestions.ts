import { ApiError, type FavouriteQuestion } from '@loxaic/api-client';
import { MAX_FAVOURITE_QUESTIONS, checkFavouriteQuestion } from '@loxaic/types';

/**
 * What the new-chat screen knows about the person's favourite questions.
 * `failed` (could not ask) is kept apart from an empty list: a person whose
 * list did not load must not be shown "add your first question". An older
 * server has no such list at all (`unsupported`).
 */
export type FavouritesLoad =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'unsupported' }
  | { status: 'ready'; questions: FavouriteQuestion[] };

export type FavouritesView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'hidden' }
  | { kind: 'empty' }
  | { kind: 'list'; questions: FavouriteQuestion[]; canAdd: boolean };

/** `reachable`: whether the server can be asked now. A list never loaded
 * while it cannot be is "could not ask", not a spinner that never ends; the
 * hook asks as soon as the server is back. */
export function favouritesView(load: FavouritesLoad, reachable: boolean): FavouritesView {
  switch (load.status) {
    case 'loading':
      return reachable ? { kind: 'loading' } : { kind: 'failed' };
    case 'failed':
      return { kind: 'failed' };
    case 'unsupported':
      return { kind: 'hidden' };
    case 'ready':
      return load.questions.length === 0
        ? { kind: 'empty' }
        : { kind: 'list', questions: load.questions, canAdd: load.questions.length < MAX_FAVOURITE_QUESTIONS };
  }
}

/** A failed load: a 404 is a server from before favourite questions, which
 * has nothing to show; anything else is "could not ask", worth a retry. */
export function failedLoad(err: unknown): FavouritesLoad {
  return err instanceof ApiError && err.status === 404 ? { status: 'unsupported' } : { status: 'failed' };
}

/** What a failed remove says, or null for nothing: a 404 is a question
 * already gone (another device, or a repeat of this one), which is what was
 * asked for, so the list is only refreshed. */
export function removeFailure(err: unknown): string | null {
  return err instanceof ApiError && err.status === 404 ? null : 'Could not remove that question';
}

/**
 * The add dialog's check, before asking: the same rules as the server's, so
 * Save is only offered for a question it will keep. Null while the field is
 * blank, so a dialog that just opened does not start with an error.
 */
export function draftProblem(draft: string, existing: readonly FavouriteQuestion[]): string | null {
  if (!draft.trim()) return null;
  const checked = checkFavouriteQuestion(draft);
  if ('error' in checked) return checked.error;
  if (existing.some((q) => q.text === checked.text)) return 'That one is already a favourite.';
  return null;
}
