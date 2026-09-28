import { describe, expect, it } from 'vitest';
import { initialInstructionsState, instructionsReducer } from './projectInstructionsState';

const found = { status: 'found' as const, path: 'AGENTS.md', mode: 'full' as const, tokens: 900, sourceBytes: 3600, sourceTruncated: false };

describe('instructionsReducer', () => {
  it('clears the summary the moment another conversation is selected', () => {
    const a = instructionsReducer(instructionsReducer(initialInstructionsState, { type: 'select', conversationId: 'a' }), {
      type: 'loaded', conversationId: 'a', summary: found,
    });
    expect(a.summary).toEqual(found);
    expect(instructionsReducer(a, { type: 'select', conversationId: 'b' })).toEqual({ conversationId: 'b', summary: undefined });
  });

  it('drops a late answer for a conversation no longer selected', () => {
    const b = instructionsReducer(initialInstructionsState, { type: 'select', conversationId: 'b' });
    expect(instructionsReducer(b, { type: 'loaded', conversationId: 'a', summary: found })).toBe(b);
    expect(instructionsReducer(b, { type: 'failed', conversationId: 'a' })).toBe(b);
  });

  it('keeps what is shown while the same conversation is asked again', () => {
    const a = instructionsReducer(instructionsReducer(initialInstructionsState, { type: 'select', conversationId: 'a' }), {
      type: 'loaded', conversationId: 'a', summary: found,
    });
    expect(instructionsReducer(a, { type: 'select', conversationId: 'a' })).toBe(a);
  });

  it('keeps what is shown when a refresh of the same conversation fails', () => {
    // The end-of-run refetch failing once used to blank the Inspector's whole
    // section, for a snapshot that had not changed.
    const a = instructionsReducer(instructionsReducer(initialInstructionsState, { type: 'select', conversationId: 'a' }), {
      type: 'loaded', conversationId: 'a', summary: found,
    });
    expect(instructionsReducer(a, { type: 'failed', conversationId: 'a' })).toBe(a);
  });
});
