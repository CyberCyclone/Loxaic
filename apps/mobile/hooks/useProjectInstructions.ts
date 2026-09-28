import { useEffect, useReducer } from 'react';
import { getConversation, type ProjectInstructionsSummary } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';
import { initialInstructionsState, instructionsReducer } from '@/lib/projectInstructionsState';

/**
 * What the agent is told about the project's own AGENTS.md: which file, how
 * big, and whether it went in whole or as an outline.
 *
 * Fetched, and fetched again whenever a run ends, because the server looks for
 * the file on a conversation's first run — before that there is nothing to
 * show, and nothing in the stream announces it afterwards. The staleness
 * rules live in lib/projectInstructionsState.ts.
 *
 * `undefined` means not known (not fetched, a local id, an older server);
 * `null` means the server has not looked yet.
 */
export function useProjectInstructions(
  conversationId: string | null,
  refreshKey?: unknown,
): ProjectInstructionsSummary | null | undefined {
  const [state, dispatch] = useReducer(instructionsReducer, initialInstructionsState);
  // An optimistic id (`pending-*`) has never been seen by the server.
  const id = conversationId && isServerConvId(conversationId) ? conversationId : null;

  useEffect(() => {
    dispatch({ type: 'select', conversationId: id });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    getConversation(id)
      .then((conv) => { dispatch({ type: 'loaded', conversationId: id, summary: conv.instructions }); })
      .catch(() => { dispatch({ type: 'failed', conversationId: id }); });
  }, [id, refreshKey]);

  return state.conversationId === id ? state.summary : undefined;
}
