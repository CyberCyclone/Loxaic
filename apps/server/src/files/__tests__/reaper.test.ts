import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq, inArray, sql } from "@shannon/db";
import { attachments, messages, user } from "@shannon/db/schema";
import { attachmentPath, attachmentTextPath } from "../storage.ts";
import { sweepOrphanAttachments, usedAttachmentBytes } from "../reaper.ts";

/**
 * Integration test against the real dev Postgres, for the only reclaim path
 * attachments have.
 *
 * Without it, an image the user picks and never sends accumulates forever: it
 * is uploaded, rowed, and then referenced by nothing, while `POST /v1/files`
 * has already recorded who uploaded it.
 *
 * The sweep is scoped to this test's own users; unscoped is what production
 * runs, and collecting other rows out of a shared dev database would be a
 * nasty surprise.
 */
describe("sweepOrphanAttachments", () => {
  const owner = `test-reaper-${uuid()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-reaper-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;
  const convId = uuid();

  /** Creates an attachment row + its file, optionally backdated past the grace. */
  async function seed(opts: { agedHours?: number; bytes?: number } = {}): Promise<string> {
    const id = uuid();
    const size = opts.bytes ?? 8;
    await db.insert(attachments).values({ id, ownerId: owner, mime: "image/png", sizeBytes: size });
    if (opts.agedHours) {
      await db
        .update(attachments)
        .set({ createdAt: sql`now() - make_interval(hours => ${opts.agedHours})` })
        .where(eq(attachments.id, id));
    }
    writeFileSync(attachmentPath(id), Buffer.alloc(size, 7));
    return id;
  }

  /** Persists a user message whose content block references `ref`. */
  async function reference(ref: string): Promise<void> {
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      lamport: 1,
      status: "complete",
      content: [
        { kind: "attachment", ref, mime: "image/png" },
        { kind: "text", text: "look at this" },
      ],
    });
  }

  beforeAll(async () => {
    process.env.UPLOADS_DIR = dir;
    await db.insert(user).values({
      id: owner,
      name: "Reaper Test",
      email: `${owner}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(attachments).where(eq(attachments.ownerId, owner));
    await db.delete(user).where(eq(user.id, owner));
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects an aged, unreferenced upload — row and bytes together", async () => {
    const orphan = await seed({ agedHours: 48 });
    expect(existsSync(attachmentPath(orphan))).toBe(true);

    const reaped = await sweepOrphanAttachments([owner]);

    expect(reaped).toBe(1);
    expect(existsSync(attachmentPath(orphan))).toBe(false);
    const rows = await db.select().from(attachments).where(eq(attachments.id, orphan));
    expect(rows).toEqual([]);
  });

  it("also removes the cached .txt extraction sidecar, not just the original upload", async () => {
    const orphan = await seed({ agedHours: 48 });
    writeFileSync(attachmentTextPath(orphan), "cached extracted text", "utf8");
    expect(existsSync(attachmentTextPath(orphan))).toBe(true);

    const reaped = await sweepOrphanAttachments([owner]);

    expect(reaped).toBe(1);
    expect(existsSync(attachmentPath(orphan))).toBe(false);
    expect(existsSync(attachmentTextPath(orphan))).toBe(false);
  });

  it("keeps an aged upload that a message still references", async () => {
    const kept = await seed({ agedHours: 48 });
    await reference(kept);

    await sweepOrphanAttachments([owner]);

    expect(existsSync(attachmentPath(kept))).toBe(true);
    const rows = await db.select().from(attachments).where(eq(attachments.id, kept));
    expect(rows).toHaveLength(1);
  });

  it("keeps an unreferenced upload that is still inside the grace period", async () => {
    const fresh = await seed();

    await sweepOrphanAttachments([owner]);

    expect(existsSync(attachmentPath(fresh))).toBe(true);
    const rows = await db.select().from(attachments).where(eq(attachments.id, fresh));
    expect(rows).toHaveLength(1);
  });

  it("is a no-op when there is nothing to collect", async () => {
    await expect(sweepOrphanAttachments([owner])).resolves.toBe(0);
  });
});

describe("usedAttachmentBytes", () => {
  const owner = `test-quota-${uuid()}`;
  const other = `test-quota-other-${uuid()}`;

  beforeAll(async () => {
    await db.insert(user).values([
      { id: owner, name: "Q", email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: other, name: "Q2", email: `${other}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    await db.delete(attachments).where(inArray(attachments.ownerId, [owner, other]));
    await db.delete(user).where(inArray(user.id, [owner, other]));
  });

  it("is 0 for a user with nothing stored, not null", async () => {
    await expect(usedAttachmentBytes(owner)).resolves.toBe(0);
  });

  it("sums only that user's rows", async () => {
    await db.insert(attachments).values([
      { id: uuid(), ownerId: owner, mime: "image/png", sizeBytes: 100 },
      { id: uuid(), ownerId: owner, mime: "image/png", sizeBytes: 250 },
      { id: uuid(), ownerId: other, mime: "image/png", sizeBytes: 9999 },
    ]);
    await expect(usedAttachmentBytes(owner)).resolves.toBe(350);
  });

  it("returns a number, not the string postgres.js hands back for SUM over an integer column", async () => {
    await expect(usedAttachmentBytes(owner)).resolves.toBeTypeOf("number");
  });
});
