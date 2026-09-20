import { db, eq, sql } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";

/**
 * The models a user actually reaches for, so the picker can put them at the
 * top instead of making them scroll a provider's whole catalogue to find the
 * one they used an hour ago.
 *
 * Recorded on a *send*, not on a tap in the picker: what belongs at the top is
 * what the user ran, and a model they opened and thought better of is not
 * that. Keyed to the sender rather than the conversation's owner, because on a
 * shared conversation the person choosing is the person typing.
 */

/** Long enough to hold a working set across a few projects, short enough that
 * the section stays scannable at the top of the picker without scrolling. */
export const RECENT_MODELS_MAX = 8;

/**
 * The last reference recorded for each user in this process.
 *
 * An ordinary conversation sends the same model turn after turn, and each of
 * those would otherwise be a write to `user_prefs` that changes nothing. This
 * skips them. It is a cache of our own last write, so being wrong after a
 * restart or on another instance costs one redundant update, never a wrong
 * list — the statement itself is idempotent.
 */
const lastRecorded = new Map<string, string>();

export function normalizeRecentModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= RECENT_MODELS_MAX) break;
  }
  return out;
}

export async function getRecentModels(userId: string): Promise<string[]> {
  const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
  return normalizeRecentModels(row?.recentModels);
}

/**
 * Move `ref` to the front of the user's list.
 *
 * One statement, so two sends racing cannot read the same list and write back
 * two different move-to-fronts. Never throws: a failed write costs a
 * mis-ordered picker, which must not fail the turn it was recorded for.
 *
 * Awaited by its callers rather than fired and forgotten. It is one upsert on
 * a primary key, skipped entirely when the user is sending with the same model
 * as last time — which is every turn of an ordinary conversation — so the cost
 * is a single round trip on a model switch. What awaiting buys is that the
 * write cannot outlive the request that caused it: a `user_prefs` row
 * appearing after the surrounding work has finished is a foreign key waiting
 * to be violated by a user deletion, and a source of failures with no visible
 * cause.
 */
export async function recordModelUse(userId: string, ref: string): Promise<void> {
  // `"default"` is the sentinel a client sends when it named no model at all
  // (see ws/chat.ts). It is not a model anyone picked, and offering it back as
  // a recent one would be offering a string no backend serves.
  if (!ref || ref === "default") return;
  if (lastRecorded.get(userId) === ref) return;

  try {
    await db
      .insert(userPrefs)
      .values({ userId, recentModels: [ref] })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: {
          // Prepend, drop any earlier copy of this ref, keep the first N.
          // jsonb throughout: the column is jsonb and a text round trip would
          // re-encode every element.
          recentModels: sql`(
            SELECT COALESCE(jsonb_agg(m.value ORDER BY m.ord), '[]'::jsonb)
            FROM (
              SELECT value, ord
              FROM jsonb_array_elements(
                ${JSON.stringify([ref])}::jsonb ||
                COALESCE(${userPrefs.recentModels}, '[]'::jsonb)
              ) WITH ORDINALITY AS t(value, ord)
              WHERE ord = 1 OR value <> ${JSON.stringify(ref)}::jsonb
              ORDER BY ord
              LIMIT ${RECENT_MODELS_MAX}
            ) AS m
          )`,
          updatedAt: new Date(),
        },
      });
    lastRecorded.set(userId, ref);
  } catch {
    // The turn is what matters; the ordering of a list in a picker is not.
  }
}

/** Test seam: the skip cache is process-global and vitest shares one process. */
export function __resetRecentModelsForTest(): void {
  lastRecorded.clear();
}
