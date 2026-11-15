/**
 * Progress reviews as records: every review a run has had, kept so its card
 * can be shown in the thread at any later time and opened for its details.
 *
 * A record is for people. It is never a `messages` row and nothing that
 * builds a prompt reads this table: what a run is told by a review is the
 * note the engine persists (`progressNoteText`), and nothing else.
 *
 * The builders are pure; the reads and the one write are here so that the
 * engine, the routes and a rewind all agree on what a row is.
 */
import { db, and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNull, type sql } from "@loxaic/db";
import { runReviews } from "@loxaic/db/schema";
import type { RunReview, RunReviewDetail } from "@loxaic/types";
import type { ReviewRecord } from "./progress-review.ts";

type Row = typeof runReviews.$inferSelect;

/** A whole number for an integer column, or null. llama.cpp reports its
 * timings in fractional milliseconds (see `usageRecordValues`). */
function whole(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value);
}

/** The `run_reviews` row for one ended review. */
export function runReviewValues(input: {
  conversationId: string;
  runId: string;
  /** The model that was asked; ignored for the ceiling, which asked none. */
  model: string;
  record: ReviewRecord;
}): typeof runReviews.$inferInsert {
  const { record } = input;
  const result = record.result;
  return {
    id: record.id,
    conversationId: input.conversationId,
    runId: input.runId,
    lamport: record.lamport,
    step: record.step,
    workedMs: Math.max(0, Math.round(record.workedMs)),
    mode: record.mode,
    trigger: record.trigger,
    verdict: record.verdict,
    reason: record.reason,
    action: record.action,
    forced: record.forced,
    digest: record.digest,
    model: record.trigger === "limit" ? null : input.model,
    inputTokens: whole(result?.usage.prompt_tokens),
    outputTokens: whole(result?.usage.completion_tokens),
    promptMs: whole(result?.timings?.prompt_ms),
    generationMs: whole(result?.timings?.predicted_ms),
    totalMs: Math.max(0, Math.round(record.endedAt - record.startedAt)),
    startedAt: new Date(record.startedAt),
    endedAt: new Date(record.endedAt),
  };
}

/** A stored review as its card: everything but what it cost and the digest. */
export function publicRunReview(row: Omit<Row, "digest">): RunReview {
  return {
    id: row.id,
    stream_id: row.runId,
    lamport: row.lamport,
    step: row.step,
    worked_ms: row.workedMs,
    mode: row.mode,
    trigger: row.trigger,
    started_at: row.startedAt.getTime(),
    ended_at: row.endedAt.getTime(),
    verdict: row.verdict,
    ...(row.reason ? { reason: row.reason } : {}),
    action: row.action,
    ...(row.forced ? { forced: true as const } : {}),
  };
}

/** A stored review in full, for its panel. */
export function publicRunReviewDetail(row: Row): RunReviewDetail {
  return {
    ...publicRunReview(row),
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    prompt_ms: row.promptMs,
    generation_ms: row.generationMs,
    total_ms: row.totalMs,
    digest: row.digest,
  };
}

/** Writes a review's record. Never throws: a record that could not be
 * written costs the thread a card, never the run its turn. */
export async function recordRunReview(input: Parameters<typeof runReviewValues>[0]): Promise<void> {
  try {
    await db.insert(runReviews).values(runReviewValues(input));
  } catch (err) {
    console.warn(`could not record a progress review: ${(err as Error).message}`);
  }
}

/** The most reviews one listing returns: the newest, in thread order. A run
 * reviewed every three steps for a day does not reach it. */
export const RUN_REVIEW_LIST_LIMIT = 500;

/** A conversation's reviews in thread order, without their digests. */
export async function listRunReviews(conversationId: string): Promise<RunReview[]> {
  const { digest: _digest, ...columns } = getTableColumns(runReviews);
  const newest = await db
    .select(columns)
    .from(runReviews)
    .where(and(eq(runReviews.conversationId, conversationId), isNull(runReviews.deletedAt)))
    .orderBy(desc(runReviews.lamport), desc(runReviews.startedAt))
    .limit(RUN_REVIEW_LIST_LIMIT);
  return newest.reverse().map(publicRunReview);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One review of `conversationId` in full; null when it has none by that id
 * (another conversation's review included, and an id that is no uuid). */
export async function getRunReview(conversationId: string, reviewId: string): Promise<RunReviewDetail | null> {
  if (!UUID.test(reviewId)) return null;
  const row = await db
    .select()
    .from(runReviews)
    .where(and(eq(runReviews.id, reviewId), eq(runReviews.conversationId, conversationId), isNull(runReviews.deletedAt)))
    .orderBy(asc(runReviews.startedAt))
    .limit(1)
    .then((rows) => rows.at(0));
  return row ? publicRunReviewDetail(row) : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Removes the reviews that followed a rewound part of `conversationId`: those
 * that started at or after (`inclusive`) the pivot message was created, the
 * rule a rewind applies to messages. `keep` stamps them instead, as removed
 * messages are stamped where they are kept for an audit. `pivotCreatedAt` is
 * SQL for the pivot's stored `created_at`, so it must be read before the
 * pivot's own row can go.
 */
export async function removeRunReviewsSince(
  tx: Tx,
  conversationId: string,
  pivotCreatedAt: ReturnType<typeof sql>,
  opts: { inclusive: boolean; keep: boolean; now: Date },
): Promise<void> {
  const where = and(
    eq(runReviews.conversationId, conversationId),
    isNull(runReviews.deletedAt),
    opts.inclusive ? gte(runReviews.startedAt, pivotCreatedAt) : gt(runReviews.startedAt, pivotCreatedAt),
  );
  if (opts.keep) await tx.update(runReviews).set({ deletedAt: opts.now }).where(where);
  else await tx.delete(runReviews).where(where);
}

/** Erases every review of the given conversations. */
export async function eraseRunReviews(tx: Tx, conversationIds: readonly string[]): Promise<void> {
  if (conversationIds.length === 0) return;
  await tx.delete(runReviews).where(inArray(runReviews.conversationId, [...conversationIds]));
}
