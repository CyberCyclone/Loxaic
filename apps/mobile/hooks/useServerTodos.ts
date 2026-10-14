import { useCallback, useEffect, useRef, useState } from 'react';
import { getConversationTodos } from '@loxaic/api-client';
import { useServerReachable } from '@/lib/connection';
import { isServerConvId } from '@/lib/streamMessages';
import { afterTodosFailure, serverTodosFor, type ServerTodos, type ServerTodosEntry } from '@/lib/todos';

/**
 * The agent's newest todo list as the server has it, for the case the loaded
 * messages cannot answer: the call that wrote it is on a history page not yet
 * loaded. Asked only then (`needed`, from lib/todos.ts's needsServerTodos), so
 * an ordinary thread, whose list is on its newest page, costs no request.
 *
 * Asked again after a rewind (`rewinds`): it can remove the list that was
 * loaded, and the answer from before it may describe a turn that is gone. Not
 * after a run: a list a run writes arrives in the messages. Asked again when
 * the server comes back, and on `retry`.
 */
export function useServerTodos(
  conversationId: string | null,
  opts: { needed: boolean; rewinds: number },
): { todos: ServerTodos; retry: () => void } {
  const reachable = useServerReachable();
  const id = conversationId && isServerConvId(conversationId) && opts.needed ? conversationId : null;
  const identity = id ? `${id}|${String(opts.rewinds)}` : null;
  const [entry, setEntry] = useState<ServerTodosEntry | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id || !identity) return;
    if (!reachable) {
      setEntry((prev) => afterTodosFailure(prev, identity));
      return;
    }
    // The server coming back is no reason to ask again for an answer in hand.
    const have = entryRef.current;
    if (have?.identity === identity && have.value.status === 'known') return;
    let live = true;
    getConversationTodos(id)
      .then((todos) => {
        if (live) setEntry({ identity, value: { status: 'known', todos } });
      })
      .catch(() => {
        if (live) setEntry((prev) => afterTodosFailure(prev, identity));
      });
    return () => {
      live = false;
    };
  }, [id, identity, reachable, attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  return { todos: serverTodosFor(entry, identity), retry };
}
