import { unlink } from "node:fs/promises";
import { db, eq, sql } from "@loxaic/db";
import { attachments } from "@loxaic/db/schema";
import { attachmentPath } from "./storage.ts";
import { removeExtractedText } from "./extract.ts";

/** How often the sweep runs once started. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Default grace before an unreferenced upload is collected. */
const DEFAULT_ORPHAN_GRACE_HOURS = 24;

/** Default per-user ceiling on stored attachment bytes. */
const DEFAULT_USER_QUOTA_BYTES = 1024 * 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function orphanGraceHours(): number {
  return envInt("ATTACHMENT_ORPHAN_GRACE_HOURS", DEFAULT_ORPHAN_GRACE_HOURS);
}

export function userQuotaBytes(): number {
  return envInt("ATTACHMENT_USER_QUOTA_BYTES", DEFAULT_USER_QUOTA_BYTES);
}

/**
 * Bytes this user already has stored.
 *
 * `::float8` rather than `::int` per the house rule: postgres.js hands back
 * `SUM()` over an `integer` column as a string, and a 32-bit cast would put a
 * 2 GB ceiling on a quota that is meant to be configurable above it.
 */
export async function usedAttachmentBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({
      // The cached extraction is real disk this user owns — the same disk the
      // sweep below deletes. Counting only the original under-reports a text
      // attachment by roughly 2x, so a nominal 100 MB quota would hold ~200 MB
      // and ATTACHMENT_USER_QUOTA_BYTES would not mean what an admin sizing a
      // disk assumes. This is also what the extract_bytes column is for.
      used: sql<number>`coalesce(sum(${attachments.sizeBytes} + coalesce(${attachments.extractBytes}, 0)), 0)::float8`,
    })
    .from(attachments)
    .where(eq(attachments.ownerId, userId));
  // An aggregate with no GROUP BY always returns exactly one row, and the
  // coalesce makes that row's value 0 rather than null when the user has
  // nothing stored.
  return row.used;
}

/**
 * Deletes uploads that no message references and that are past the grace
 * period, rows and bytes together. Returns how many were collected.
 *
 * Uploads accumulate forever without this: the image a user picks and then
 * never sends is uploaded, its row written, and never referenced, while
 * `POST /v1/files` has already recorded
 * `{id, owner_id, mime, size_bytes, created_at}` and left the bytes on disk.
 * There is no other reclaim path: no DELETE route, no cascade from message
 * deletion.
 *
 * The default grace matches STREAM_TTL_SECONDS' own 24h default. An image
 * collected out from under a still-open thread degrades to
 * "[image unavailable]" rather than failing the run.
 *
 * The referenced-ref set is materialized once per sweep rather than probed per
 * attachment — `messages.content` has no GIN index, so a correlated lookup
 * would re-scan the table for every candidate row.
 */
export async function sweepOrphanAttachments(ownerIds?: string[]): Promise<number> {
  // Production sweeps every owner. `ownerIds` exists so the test suite — which
  // runs against the shared dev database — can exercise the real statement
  // without collecting rows it didn't create.
  // sql.join rather than `= ANY(${ownerIds})`: drizzle binds a JS array as a
  // single scalar parameter, which Postgres then rejects as a malformed array
  // literal.
  const scope = ownerIds
    ? sql`AND a.owner_id IN (${sql.join(ownerIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    WITH referenced AS (
      SELECT DISTINCT block->>'ref' AS ref
      FROM messages m, LATERAL jsonb_array_elements(m.content) AS block
      WHERE jsonb_typeof(m.content) = 'array' AND block->>'kind' = 'attachment'
    )
    DELETE FROM attachments a
    WHERE a.created_at < now() - make_interval(hours => ${orphanGraceHours()})
      AND NOT EXISTS (SELECT 1 FROM referenced r WHERE r.ref = a.id::text)
      ${scope}
    RETURNING a.id
  `);

  let reaped = 0;
  for (const row of rows) {
    // The row is already gone; a failed unlink leaves a file nothing can find
    // by row, which the next sweep also can't see. Logged by the caller via
    // the count, not retried — losing one file is not worth blocking the rest.
    await unlink(attachmentPath(row.id)).catch(() => undefined);
    // The cached extraction must not outlive the file it describes.
    await removeExtractedText(row.id);
    reaped++;
  }
  return reaped;
}

export function startAttachmentReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepOrphanAttachments().then(
      (n) => {
        if (n > 0) onReap?.(n);
      },
      () => undefined,
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
