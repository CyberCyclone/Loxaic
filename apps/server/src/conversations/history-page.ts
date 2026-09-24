import { and, asc, db, desc, eq, inArray, isNull, sql } from "@loxaic/db";
import { messages } from "@loxaic/db/schema";

/**
 * One page of a conversation's messages, newest first — the page a thread
 * opens on, and each older page scrolling back asks for (#213).
 *
 * Both history routes used to take the *oldest* rows (`ORDER BY created_at
 * LIMIT n`), so a long thread reloaded without its newest messages, which are
 * the ones anyone comes back for. They also ordered by `created_at` alone,
 * while the engine replays by `(lamport, created_at)`: two rows written in the
 * same millisecond could come back in a different order from the one the model
 * saw. Pages are cut and returned in the engine's order, with the id as a final
 * tiebreak so a cursor is exact.
 *
 * **A page starts on a user message**, so it holds whole turns. The limit is
 * therefore a floor: the page grows backwards to the turn's user row. That is
 * what keeps an assistant `tool_call` and its `tool` result rows in the same
 * page — the client joins them by call id and cannot join across pages — and
 * it is why the newest page always holds the whole last turn. A turn longer
 * than `PAGE_CEILING` rows (a long agent run) is cut at the ceiling instead,
 * moved forward past any `tool` rows at its old edge so a call is still never
 * separated from its results.
 */

/** The most rows one page may hold, however long the turn it is extending to
 * reach the start of. */
export const PAGE_CEILING = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MessagePage {
  /** Full rows, oldest first — the order the client renders and replays. */
  rows: (typeof messages.$inferSelect)[];
  /** Whether anything older than this page exists. */
  hasMore: boolean;
  /** Pass back as `before` to get the next older page. Null when there is none.
   * It is the id of this page's oldest row, and only means anything in this
   * conversation. */
  before: string | null;
}

/** A `before` cursor that is not a message in this conversation. */
export class BadCursorError extends Error {
  constructor() {
    super("Unknown cursor");
  }
}

export async function loadMessagePage(
  conversationId: string,
  opts: { limit: number; before?: string | null },
): Promise<MessagePage> {
  const { limit } = opts;
  const visible = and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt));

  let older = visible;
  if (opts.before !== undefined && opts.before !== null) {
    // Shape-checked before it reaches a uuid column, where Postgres would
    // answer anything else with a 500.
    if (!UUID_RE.test(opts.before)) throw new BadCursorError();
    // Resolved in SQL rather than carried in the cursor: `created_at` has
    // microsecond precision in Postgres and millisecond precision in a JS
    // Date, so a timestamp that went through the client would compare wrong.
    // The row need not be visible — a cursor onto a message deleted since is
    // still a position in the thread.
    const cursor = await db.query.messages.findFirst({
      where: and(eq(messages.id, opts.before), eq(messages.conversationId, conversationId)),
      columns: { id: true },
    });
    if (!cursor) throw new BadCursorError();
    older = and(
      visible,
      sql`(${messages.lamport}, ${messages.createdAt}, ${messages.id}) < (select m.lamport, m.created_at, m.id from messages m where m.id = ${opts.before})`,
    );
  }

  // Keys only, newest first, one past the ceiling — enough to find the turn
  // boundary and to know whether anything is left, without reading a thousand
  // rows of content to return two hundred.
  const keys = await db
    .select({ id: messages.id, authorType: messages.authorType })
    .from(messages)
    .where(older)
    .orderBy(desc(messages.lamport), desc(messages.createdAt), desc(messages.id))
    .limit(PAGE_CEILING + 1);

  const end = pageEnd(keys, limit);
  const pageIds = keys.slice(0, end).map((k) => k.id);
  const hasMore = keys.length > end;

  const rows = pageIds.length
    ? await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, pageIds)))
        .orderBy(asc(messages.lamport), asc(messages.createdAt), asc(messages.id))
    : [];

  return { rows, hasMore, before: hasMore ? (pageIds.at(-1) ?? null) : null };
}

/**
 * How many of `keys` (newest first) belong to this page. Pure, so the boundary
 * rules are tested without a database.
 */
export function pageEnd(keys: readonly { authorType: string }[], limit: number, ceiling = PAGE_CEILING): number {
  if (keys.length <= limit) return keys.length;
  // Grow backwards until the oldest row in the page is a user message.
  let end = limit;
  while (end < keys.length && end < ceiling && keys[end - 1].authorType !== "user") end++;
  if (end === keys.length || keys[end - 1].authorType === "user") return end;
  // The turn is longer than the ceiling. Cut it, but never with a `tool` row
  // as the page's oldest: its call is one row older, and would land in the
  // next page. Giving those rows up to the older page keeps them beside it.
  while (end > 1 && keys[end - 1].authorType === "tool") end--;
  return end;
}
