import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { db, eq, sql } from "@loxaic/db";
import { user, userPrefs } from "@loxaic/db/schema";

/**
 * Migration 0043 retires an "allow always" for the whole bash tool. Its data
 * statement is run here as written, scoped to this suite's own user so the
 * shared database's other rows are left alone.
 */
const migration = readFileSync(new URL("../../../../../packages/db/drizzle/0043_command_rules.sql", import.meta.url), "utf8");
const retire = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes("UPDATE \"user_prefs\""));

describe("migration 0043's retirement of whole-bash grants", () => {
  const withBash = `test-mig43-a-${uuid()}`;
  const without = `test-mig43-b-${uuid()}`;

  beforeAll(async () => {
    for (const id of [withBash, without]) {
      await db.insert(user).values({ id, name: "m", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    }
    await db.insert(userPrefs).values([
      { userId: withBash, toolAllowlist: ["fs_write", "bash"] },
      { userId: without, toolAllowlist: ["fs_write"] },
    ]);
  });
  afterAll(async () => {
    for (const id of [withBash, without]) await db.delete(user).where(eq(user.id, id));
  });

  it("drops bash, keeps the rest, and marks only the users it changed", async () => {
    expect(retire).toBeDefined();
    const statement = (retire ?? "")
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .replace(/;\s*$/, "")
      .replace("WHERE", `WHERE "user_id" IN ('${withBash}', '${without}') AND`);
    await db.execute(sql.raw(statement));
    const rows = await db.query.userPrefs.findMany({ where: (p, { inArray }) => inArray(p.userId, [withBash, without]) });
    const by = new Map(rows.map((r) => [r.userId, r]));
    expect(by.get(withBash)?.toolAllowlist).toEqual(["fs_write"]);
    expect(by.get(withBash)?.bashGrantRetiredAt).toBeInstanceOf(Date);
    expect(by.get(without)?.toolAllowlist).toEqual(["fs_write"]);
    expect(by.get(without)?.bashGrantRetiredAt).toBeNull();
  });
});
