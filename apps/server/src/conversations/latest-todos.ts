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
 *
 * Bounded: rows are tested for a `todo_write` call by jsonb containment, which
 * expands nothing, and only the newest `CANDIDATE_ROWS` that have one are
 * expanded into their blocks. Expanding every row's content before ordering,
 * as the first version did, unpacked every tool result of a long thread on
 * every ask. The client asks only when the history it has loaded holds no list.
 */
const CANDIDATE_ROWS = 20;

export async function latestTodos(conversationId: string): Promise<Todo[] | null> {
  const rows = await db.execute<{ args: unknown; ok: boolean | null }>(sql`
    WITH candidates AS (
      SELECT m.id, m.content, m.lamport, m.created_at
      FROM messages m
      WHERE m.conversation_id = ${conversationId}
        AND m.author_type = 'assistant'
        AND m.deleted_at IS NULL
        AND jsonb_typeof(m.content) = 'array'
        AND m.content @> '[{"kind": "tool_call", "tool": "todo_write"}]'::jsonb
      ORDER BY m.lamport DESC, m.created_at DESC
      LIMIT ${CANDIDATE_ROWS}
    ), calls AS (
      SELECT block->'args' AS args, block->>'call_id' AS call_id, c.id AS message_id,
             c.lamport, c.created_at, pos
      FROM candidates c, LATERAL jsonb_array_elements(c.content) WITH ORDINALITY AS t(block, pos)
      WHERE block->>'kind' = 'tool_call'
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
