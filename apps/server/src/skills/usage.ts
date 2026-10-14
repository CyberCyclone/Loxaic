/**
 * How often a person invokes each skill — the order the composer's "/"
 * palette lists them in, most-used first.
 *
 * Counted when a person runs a skill by name (a "/name" message, or
 * `/compact`), never when the model loads one: the order is about what the
 * person reaches for. Keyed to whoever typed it, like the picker's recent
 * models.
 */
import { db, eq, sql } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import type { SkillUse } from "./catalog.ts";

export async function getSkillUsage(userId: string): Promise<Partial<Record<string, SkillUse>>> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
    columns: { skillUsage: true },
  });
  return normalizeSkillUsage(row?.skillUsage);
}

/** Only well-formed entries: the column is plain data. */
export function normalizeSkillUsage(raw: unknown): Record<string, SkillUse> {
  const out: Record<string, SkillUse> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { count, lastUsedAt } = v as { count?: unknown; lastUsedAt?: unknown };
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    out[name] = { count, lastUsedAt: typeof lastUsedAt === "string" ? lastUsedAt : "" };
  }
  return out;
}

/**
 * One more use of `name`. A single statement, so two sends racing cannot both
 * read the same count and write back the same next one. Never throws: a lost
 * count costs the palette's order, which must not fail the turn it was
 * recorded for.
 */
export async function recordSkillUse(userId: string, name: string, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  try {
    await db
      .insert(userPrefs)
      .values({ userId, skillUsage: { [name]: { count: 1, lastUsedAt: at } } })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: {
          skillUsage: sql`COALESCE(${userPrefs.skillUsage}, '{}'::jsonb) || jsonb_build_object(
            ${name}::text,
            jsonb_build_object(
              'count', COALESCE((${userPrefs.skillUsage} -> ${name}::text ->> 'count')::int, 0) + 1,
              'lastUsedAt', ${at}::text
            )
          )`,
          updatedAt: now,
        },
      });
  } catch (err) {
    console.warn(`recording a use of the skill ${name} failed: ${(err as Error).message}`);
  }
}
