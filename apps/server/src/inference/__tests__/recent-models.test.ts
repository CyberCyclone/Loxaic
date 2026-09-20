import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { user, userPrefs } from "@loxaic/db/schema";
import {
  __resetRecentModelsForTest,
  getRecentModels,
  recordModelUse,
  RECENT_MODELS_MAX,
} from "../recent-models.ts";

/**
 * The list behind the picker's "Recently used" section.
 *
 * The move-to-front is one SQL statement rather than a read-modify-write, so
 * the cases worth holding are the ones that statement has to get right on its
 * own: order, de-duplication, and the cap.
 */
const userId = `test-recents-${uuid()}`;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "Recents Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return async () => {
    await db.delete(user).where(eq(user.id, userId));
  };
});

beforeEach(async () => {
  await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
  // The skip cache is what stops an ordinary turn costing a write; it has to
  // be cleared between cases or the second use of a model is a no-op.
  __resetRecentModelsForTest();
});

describe("recordModelUse", () => {
  it("creates the list for a user who has never had prefs", async () => {
    await recordModelUse(userId, "qwen2.5-14b-instruct");
    expect(await getRecentModels(userId)).toEqual(["qwen2.5-14b-instruct"]);
  });

  it("puts the newest first", async () => {
    await recordModelUse(userId, "a");
    await recordModelUse(userId, "b");
    await recordModelUse(userId, "c");
    expect(await getRecentModels(userId)).toEqual(["c", "b", "a"]);
  });

  it("moves an existing entry to the front instead of repeating it", async () => {
    await recordModelUse(userId, "a");
    await recordModelUse(userId, "b");
    __resetRecentModelsForTest();
    await recordModelUse(userId, "a");
    expect(await getRecentModels(userId)).toEqual(["a", "b"]);
  });

  it("caps the list", async () => {
    for (let i = 0; i < RECENT_MODELS_MAX + 4; i++) await recordModelUse(userId, `m${String(i)}`);
    const recents = await getRecentModels(userId);
    expect(recents).toHaveLength(RECENT_MODELS_MAX);
    // Newest kept, oldest dropped.
    expect(recents[0]).toBe(`m${String(RECENT_MODELS_MAX + 3)}`);
    expect(recents).not.toContain("m0");
  });

  it("keeps a provider-qualified reference whole", async () => {
    // The `slug::` prefix is what makes the entry resolvable at all — storing
    // the bare upstream id would point the picker at the wrong backend.
    await recordModelUse(userId, "work::openai/gpt-4o");
    expect(await getRecentModels(userId)).toEqual(["work::openai/gpt-4o"]);
  });

  it("ignores the no-model-chosen sentinel", async () => {
    // `ws/chat.ts` sends the literal "default" when a client names no model.
    // Nobody picked it, and no backend serves it.
    await recordModelUse(userId, "default");
    await recordModelUse(userId, "");
    expect(await getRecentModels(userId)).toEqual([]);
  });

  it("does not disturb other preferences", async () => {
    await db.insert(userPrefs).values({ userId, autoCompact: false, maxIterations: 42 });
    __resetRecentModelsForTest();
    await recordModelUse(userId, "a");
    const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    expect(row?.autoCompact).toBe(false);
    expect(row?.maxIterations).toBe(42);
    expect(row?.recentModels).toEqual(["a"]);
  });

  it("skips the write when the same model is used twice running", async () => {
    // Every turn of an ordinary conversation sends the same model; each would
    // otherwise be an update that changes nothing.
    await recordModelUse(userId, "a");
    const first = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    await recordModelUse(userId, "a");
    const second = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    expect(second?.updatedAt).toEqual(first?.updatedAt);
  });

  it("survives a user that no longer exists", async () => {
    // Fire-and-forget in spirit: a failed write costs a mis-ordered picker and
    // must never fail the turn it was recorded for.
    await expect(recordModelUse(`gone-${uuid()}`, "a")).resolves.toBeUndefined();
  });
});
