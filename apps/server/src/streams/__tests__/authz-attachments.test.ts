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

  async function newAttachmentWithFilename(ownerId: string, filename: string, mime = "text/plain"): Promise<string> {
    const id = uuid();
    await db.insert(attachments).values({ id, ownerId, mime, sizeBytes: 42, filename });
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

  it("resolves an owned ref, returning the DB's filename as `name`, not the caller's claim", async () => {
    const ref = await newAttachmentWithFilename(userA, "real-name.csv");
    const result = await assertAttachmentsOwned(userA, [ref]);
    expect(result[0]).toEqual({ ref, mime: "text/plain", name: "real-name.csv" });
  });

  it("omits `name` entirely for a row predating documents (empty filename default)", async () => {
    // Simulates an attachment from before documents existed — an old image
    // row whose filename column is still its "" default.
    const ref = await newAttachment(userA, "image/png");
    const result = await assertAttachmentsOwned(userA, [ref]);
    expect(result[0]).not.toHaveProperty("name");
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

  // One ref repeated is one image, not four. Left un-collapsed it persisted as
  // four attachment blocks, emitted four times on message.start, and rebuilt
  // into four identical image parts on every future replay — a 4x prompt
  // amplification bought with a single upload.
  it("collapses a repeated ref to one entry, keeping first-occurrence order", async () => {
    const a = await newAttachment(userA, "image/png");
    const b = await newAttachment(userA, "image/jpeg");
    await expect(assertAttachmentsOwned(userA, [a, b, a, a])).resolves.toEqual([
      { ref: a, mime: "image/png" },
      { ref: b, mime: "image/jpeg" },
    ]);
  });

  it("still caps on the raw list length, so duplicates can't smuggle in an over-long array", async () => {
    const ref = await newAttachment(userA);
    const overCap = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ref);
    await expect(assertAttachmentsOwned(userA, overCap)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a non-string element without letting it coerce past the ref check", async () => {
    // `refs: string[]` is a claim about a JSON payload; RegExp.test would
    // stringify a single-element array straight back into a valid uuid.
    const smuggled = [[await newAttachment(userA)]] as unknown as string[];
    await expect(assertAttachmentsOwned(userA, smuggled)).rejects.toBeInstanceOf(NotFoundError);
  });
});
