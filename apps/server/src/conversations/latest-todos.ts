import { db, sql } from "@loxaic/db";
import { parseTodoList, type Todo } from "@loxaic/types";

/**
 * The newest todo list a conversation's agent wrote: the arguments of its
 * latest `todo_write` call whose result was not a refusal. Null when it never
 * wrote one.
 *
 * The client's list used to be per run, from the stream, so it went blank on
 * the next turn, on switching threads and after a reload. It can mostly rebuild
 * it from the messages it has loaded, but history arrives a page at a time
 * (#213) and the call that wrote the list can be on a page nobody has scrolled
 * back to. This answers that case.
 *
 * Read the way the engine replays (lamport, then creation, then position in the
 * message), and only from rows still in the conversation: a rewind marks what
 * it removed.
 */
export async function latestTodos(conversationId: string): Promise<Todo[] | null> {
  const rows = await db.execute<{ args: unknown; ok: boolean | null }>(sql`
    WITH calls AS (
      SELECT block->'args' AS args, block->>'call_id' AS call_id, m.id AS message_id,
             m.lamport, m.created_at, pos
      FROM messages m, LATERAL jsonb_array_elements(m.content) WITH ORDINALITY AS t(block, pos)
      WHERE m.conversation_id = ${conversationId}
        AND m.author_type = 'assistant'
        AND m.deleted_at IS NULL
        AND jsonb_typeof(m.content) = 'array'
        AND block->>'kind' = 'tool_call'
        AND block->>'tool' = 'todo_write'
    )
    SELECT c.args,
      (SELECT (r.block->>'ok')::boolean
       FROM messages tm, LATERAL jsonb_array_elements(tm.content) AS r(block)
       WHERE tm.conversation_id = ${conversationId}
         AND tm.parent_id = c.message_id
         AND tm.author_type = 'tool'
         AND jsonb_typeof(tm.content) = 'array'
         AND r.block->>'kind' = 'tool_result'
         AND r.block->>'call_id' = c.call_id
       LIMIT 1) AS ok
    FROM calls c
    ORDER BY c.lamport DESC, c.created_at DESC, c.pos DESC
    LIMIT 20
  `);
  for (const row of rows) {
    // A refused call is not the agent's list; `ok` absent (a row from before
    // results carried it) is not a refusal.
    if (row.ok === false) continue;
    const todos = parseTodoList(row.args);
    if (todos) return todos;
  }
  return null;
}
