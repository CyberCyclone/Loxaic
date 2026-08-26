import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { attachments, user } from "@shannon/db/schema";
import { MAX_ATTACHMENTS } from "@shannon/types";
import { assertAttachmentsOwned, NotFoundError } from "../authz.ts";

/**
 * Integration test against the real dev Postgres — exercises the chokepoint
 * every attachment-carrying send validates through before anything is
 * written: owner / non-owner / nonexistent / malformed / over-cap, and that
 * the returned mime comes from the DB row, not the caller's claim.
 */
describe("assertAttachmentsOwned", () => {
  const userA = `test-authz-att-a-${uuid()}`;
  const userB = `test-authz-att-b-${uuid()}`;
  const attIds: string[] = [];

  async function newAttachment(ownerId: string, mime = "image/png"): Promise<string> {
    const id = uuid();
    await db.insert(attachments).values({ id, ownerId, mime, sizeBytes: 42 });
    attIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await db.insert(user).values([
      { id: userA, name: "Test A", email: `${userA}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: userB, name: "Test B", email: `${userB}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    await db.delete(attachments).where(eq(attachments.ownerId, userA));
    await db.delete(attachments).where(eq(attachments.ownerId, userB));
    await db.delete(user).where(eq(user.id, userA));
    await db.delete(user).where(eq(user.id, userB));
  });

  it("returns an empty array for an empty ref list, without querying anything", async () => {
    expect(await assertAttachmentsOwned(userA, [])).toEqual([]);
  });

  it("resolves an owned ref, returning the DB's mime rather than trusting the caller's claim", async () => {
    const ref = await newAttachment(userA, "image/webp");
    expect(await assertAttachmentsOwned(userA, [ref])).toEqual([{ ref, mime: "image/webp" }]);
  });

  it("resolves multiple owned refs in the caller's given order, not DB order", async () => {
    const first = await newAttachment(userA);
    const second = await newAttachment(userA);
    expect(await assertAttachmentsOwned(userA, [second, first])).toEqual([
      { ref: second, mime: "image/png" },
      { ref: first, mime: "image/png" },
    ]);
  });

  it("throws NotFoundError for someone else's ref — same error as a nonexistent one", async () => {
    const ref = await newAttachment(userB);
    const [msgForeign, msgMissing] = await Promise.all([
      assertAttachmentsOwned(userA, [ref]).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
      assertAttachmentsOwned(userA, [uuid()]).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
    ]);
    expect(msgForeign).toBe(msgMissing);
    await expect(assertAttachmentsOwned(userA, [ref])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a malformed (non-uuid) ref before it can reach the query", async () => {
    await expect(assertAttachmentsOwned(userA, ["../../etc/passwd"])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError once the list exceeds MAX_ATTACHMENTS, even if every ref is owned", async () => {
    const refs = await Promise.all(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => newAttachment(userA)));
    await expect(assertAttachmentsOwned(userA, refs)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails the whole batch if any single ref in it is unowned", async () => {
    const owned = await newAttachment(userA);
    const foreign = await newAttachment(userB);
    await expect(assertAttachmentsOwned(userA, [owned, foreign])).rejects.toBeInstanceOf(NotFoundError);
  });
});
