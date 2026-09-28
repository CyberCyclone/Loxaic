import type { ProjectInstructionsSummary } from '@loxaic/api-client';

/**
 * Which conversation's instructions summary is on screen, as a pure reducer
 * so the two staleness rules are unit-tested (the hook only drives it):
 *
 * - Selecting another conversation clears the summary at once. Keeping the
 *   old one until the fetch lands showed one thread's AGENTS.md under
 *   another, longest on the slow link where someone is most likely reading.
 * - A response is applied only to the conversation it was asked for. A slow
 *   answer for a thread no longer selected is dropped, the rule `openDetail`
 *   and the allowlist editor already follow.
 *
 * A refresh of the *same* conversation (a run ended) keeps what is shown until
 * the new answer lands, so the row does not blank at the end of every run.
 *
 * `summary`: undefined = not known, null = the server has not looked yet.
 */
export interface InstructionsState {
  conversationId: string | null;
  summary: ProjectInstructionsSummary | null | undefined;
}

export type InstructionsEvent =
  | { type: 'select'; conversationId: string | null }
  | { type: 'loaded'; conversationId: string; summary: ProjectInstructionsSummary | null | undefined }
  | { type: 'failed'; conversationId: string };

export const initialInstructionsState: InstructionsState = { conversationId: null, summary: undefined };

export function instructionsReducer(state: InstructionsState, event: InstructionsEvent): InstructionsState {
  switch (event.type) {
    case 'select':
      return event.conversationId === state.conversationId ? state : { conversationId: event.conversationId, summary: undefined };
    case 'loaded':
      return event.conversationId === state.conversationId ? { ...state, summary: event.summary } : state;
    case 'failed':
      return event.conversationId === state.conversationId ? { ...state, summary: undefined } : state;
  }
}
