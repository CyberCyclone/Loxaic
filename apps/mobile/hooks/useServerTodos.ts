import { useEffect, useState } from 'react';
import { getConversation, type Todo } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';

/**
 * The agent's newest todo list as the server has it (`latest_todos`), for the
 * case the loaded messages cannot answer: the call that wrote it is on a
 * history page not yet loaded. Fetched per conversation and again whenever a
 * run ends, like useProjectInstructions.
 *
 * `undefined` means not known (not fetched, a local id, a failed read, an
 * older server); `null` means the agent never wrote one.
 */
export function useServerTodos(conversationId: string | null, refreshKey?: unknown): Todo[] | null | undefined {
  const id = conversationId && isServerConvId(conversationId) ? conversationId : null;
  const [state, setState] = useState<{ id: string | null; todos: Todo[] | null | undefined }>({ id: null, todos: undefined });

  useEffect(() => {
    if (!id) return;
    let live = true;
    getConversation(id)
      .then((conv) => {
        if (live) setState({ id, todos: conv.latest_todos });
      })
      .catch(() => {
        if (live) setState((prev) => (prev.id === id ? prev : { id, todos: undefined }));
      });
    return () => {
      live = false;
    };
  }, [id, refreshKey]);

  // A previous conversation's answer is never this one's.
  return state.id === id ? state.todos : undefined;
}
