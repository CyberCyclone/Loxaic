import { describe, expect, it } from 'vitest';
import { ApiError, type FavouriteQuestion } from '@loxaic/api-client';
import { FAVOURITE_QUESTION_MAX_CHARS, MAX_FAVOURITE_QUESTIONS } from '@loxaic/types';
import { draftProblem, failedLoad, favouritesView } from './favouriteQuestions';

const q = (id: string, text = `Question ${id}`): FavouriteQuestion => ({ id, text, createdAt: '2026-11-24T00:00:00.000Z' });

describe('favouritesView', () => {
  it('keeps "could not ask" apart from "none"', () => {
    expect(favouritesView({ status: 'failed' }, true)).toEqual({ kind: 'failed' });
    expect(favouritesView({ status: 'ready', questions: [] }, true)).toEqual({ kind: 'empty' });
  });

  it('shows nothing for a server from before favourite questions', () => {
    expect(favouritesView({ status: 'unsupported' }, true)).toEqual({ kind: 'hidden' });
  });

  it('says loading while it is, and could-not-load while it cannot ask', () => {
    expect(favouritesView({ status: 'loading' }, true)).toEqual({ kind: 'loading' });
    expect(favouritesView({ status: 'loading' }, false)).toEqual({ kind: 'failed' });
  });

  it('keeps a loaded list on screen while the server is away', () => {
    const some = [q('a')];
    expect(favouritesView({ status: 'ready', questions: some }, false)).toEqual({ kind: 'list', questions: some, canAdd: true });
  });

  it('offers to add until the list is full', () => {
    const some = [q('a'), q('b')];
    expect(favouritesView({ status: 'ready', questions: some }, true)).toEqual({ kind: 'list', questions: some, canAdd: true });
    const full = Array.from({ length: MAX_FAVOURITE_QUESTIONS }, (_, i) => q(String(i)));
    expect(favouritesView({ status: 'ready', questions: full }, true)).toMatchObject({ kind: 'list', canAdd: false });
  });
});

describe('failedLoad', () => {
  it('reads a 404 as an older server and anything else as worth a retry', () => {
    expect(failedLoad(new ApiError('Not Found', 404))).toEqual({ status: 'unsupported' });
    expect(failedLoad(new ApiError('Internal', 500))).toEqual({ status: 'failed' });
    expect(failedLoad(new TypeError('Failed to fetch'))).toEqual({ status: 'failed' });
  });
});

describe('draftProblem', () => {
  it('says nothing about a blank field', () => {
    expect(draftProblem('', [])).toBeNull();
    expect(draftProblem('   ', [])).toBeNull();
  });

  it('refuses what the server would', () => {
    expect(draftProblem('x'.repeat(FAVOURITE_QUESTION_MAX_CHARS + 1), [])).toMatch(/300 characters/);
    expect(draftProblem('x'.repeat(FAVOURITE_QUESTION_MAX_CHARS), [])).toBeNull();
  });

  it('says when the question is already a favourite, after trimming', () => {
    expect(draftProblem('  Tell me a joke.  ', [q('a', 'Tell me a joke.')])).toMatch(/already/);
    expect(draftProblem('Tell me a joke!', [q('a', 'Tell me a joke.')])).toBeNull();
  });
});
