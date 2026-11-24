/**
 * A person's favourite questions, one row each in `favourite_questions`. Every
 * change is one statement on one row (or a short transaction holding the
 * person's prefs row), so an add on one device and a removal on another never
 * overwrite each other the way a whole-list write would.
 *
 * The defaults (`DEFAULT_FAVOURITE_QUESTIONS`) are given once, on the first
 * read or write, and `user_prefs.favourites_seeded_at` records that they were:
 * a person who removes every favourite keeps an empty list.
 */
import { and, count, db, eq, isNull } from "@loxaic/db";
import { favouriteQuestions, userPrefs } from "@loxaic/db/schema";
import {
  DEFAULT_FAVOURITE_QUESTIONS,
  MAX_FAVOURITE_QUESTIONS,
  checkFavouriteQuestion,
  type FavouriteQuestion,
} from "@loxaic/types";

export class FavouriteQuestionError extends Error {}

/**
 * Gives this person the defaults if nobody has yet. Two first requests at once
 * (two devices, or a GET racing a POST) both reach the upsert, but only one of
 * them sets the still-null column and gets a row back; only that one inserts.
 * The claim and the inserts share a transaction, so a failed insert leaves the
 * column null for the next request to try again.
 */
export async function ensureFavouritesSeeded(userId: string, now: () => Date = () => new Date()): Promise<void> {
  const prefs = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
    columns: { favouritesSeededAt: true },
  });
  if (prefs?.favouritesSeededAt) return;
  await db.transaction(async (tx) => {
    const at = now();
    const claimed = await tx
      .insert(userPrefs)
      .values({ userId, favouritesSeededAt: at })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { favouritesSeededAt: at },
        setWhere: isNull(userPrefs.favouritesSeededAt),
      })
      .returning({ userId: userPrefs.userId });
    if (claimed.length === 0) return;
    // A millisecond apart and all before `at`, so `created_at` alone keeps
    // them in order and a question added in the same millisecond lists after.
    const n = DEFAULT_FAVOURITE_QUESTIONS.length;
    await tx
      .insert(favouriteQuestions)
      .values(
        DEFAULT_FAVOURITE_QUESTIONS.map((text, i) => ({
          userId,
          text,
          createdAt: new Date(at.getTime() - (n - i)),
        })),
      )
      .onConflictDoNothing();
  });
}

/** This person's favourite questions, oldest first. */
export async function listFavouriteQuestions(userId: string): Promise<FavouriteQuestion[]> {
  await ensureFavouritesSeeded(userId);
  const rows = await db.query.favouriteQuestions.findMany({
    where: eq(favouriteQuestions.userId, userId),
    orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
  });
  return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt.toISOString() }));
}

/**
 * Adds a question; one already there is left as it is. Throws
 * FavouriteQuestionError for a question that is blank or too long, or when the
 * list is full. The count and the insert run while holding this person's prefs
 * row, so two adds at once cannot both take the last place.
 */
export async function addFavouriteQuestion(
  userId: string,
  value: unknown,
  now: () => Date = () => new Date(),
): Promise<void> {
  const checked = checkFavouriteQuestion(value);
  if ("error" in checked) throw new FavouriteQuestionError(checked.error);
  await ensureFavouritesSeeded(userId);
  await db.transaction(async (tx) => {
    await tx.select({ userId: userPrefs.userId }).from(userPrefs).where(eq(userPrefs.userId, userId)).for("update");
    const existing = await tx
      .select({ id: favouriteQuestions.id })
      .from(favouriteQuestions)
      .where(and(eq(favouriteQuestions.userId, userId), eq(favouriteQuestions.text, checked.text)));
    if (existing.length > 0) return;
    const [{ n }] = await tx
      .select({ n: count() })
      .from(favouriteQuestions)
      .where(eq(favouriteQuestions.userId, userId));
    if (n >= MAX_FAVOURITE_QUESTIONS) {
      throw new FavouriteQuestionError(
        `You can keep up to ${String(MAX_FAVOURITE_QUESTIONS)} favourite questions. Remove one first.`,
      );
    }
    // The app's clock, as the defaults use: the database's `now()` is another
    // clock, and the order is decided by comparing the two.
    await tx.insert(favouriteQuestions).values({ userId, text: checked.text, createdAt: now() }).onConflictDoNothing();
  });
}

/** Removes one question. False when it was not this person's or not there.
 * Not seeded first: an id is only known from a list or an add, and both seed. */
export async function deleteFavouriteQuestion(userId: string, id: string): Promise<boolean> {
  const removed = await db
    .delete(favouriteQuestions)
    .where(and(eq(favouriteQuestions.id, id), eq(favouriteQuestions.userId, userId)))
    .returning({ id: favouriteQuestions.id });
  return removed.length > 0;
}
