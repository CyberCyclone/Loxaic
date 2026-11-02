import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db, eq, sql } from "@loxaic/db";
import { sandboxImages, user } from "@loxaic/db/schema";

/**
 * Migration 0052 moves shared images still on the old default process limit
 * to the new one. Its statement is run here as written, scoped to this
 * suite's own rows so the shared database's other images are left alone.
 */
const migration = readFileSync(new URL("../../../../../packages/db/drizzle/0052_shared_image_pids.sql", import.meta.url), "utf8");
const statement = migration
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .trim()
  .replace(/;\s*$/, "");

describe("migration 0052's raise of the old default process limit", () => {
  const creator = `test-mig52-${randomUUID()}`;

  beforeAll(async () => {
    await db.insert(user).values({ id: creator, name: "m", email: `${creator}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  });

  afterAll(async () => {
    await db.delete(sandboxImages).where(eq(sandboxImages.createdBy, creator));
    await db.delete(user).where(eq(user.id, creator));
  });

  async function image(ownerId: string | null, limits: unknown): Promise<string> {
    const [row] = await db
      .insert(sandboxImages)
      .values({ ownerId, reference: `example.test/${randomUUID()}:1`, label: "m", status: "ready", limits, createdBy: creator })
      .returning();
    return row.id;
  }

  async function limitsOf(id: string): Promise<unknown> {
    return (await db.query.sandboxImages.findFirst({ where: eq(sandboxImages.id, id) }))?.limits;
  }

  it("raises a shared image on 100 and keeps every other value", async () => {
    const old = await image(null, { memoryMb: 2048, cpus: 2, pids: 100, kvm: true });
    const chosen = await image(null, { memoryMb: 512, cpus: 1, pids: 200 });
    const personal = await image(creator, null);

    await db.execute(sql.raw(`${statement} AND "created_by" = '${creator}'`));

    expect(await limitsOf(old)).toEqual({ memoryMb: 2048, cpus: 2, pids: 4096, kvm: true });
    expect(await limitsOf(chosen)).toEqual({ memoryMb: 512, cpus: 1, pids: 200 });
    expect(await limitsOf(personal)).toBeNull();
  });
});
