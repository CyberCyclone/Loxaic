import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { db, eq, inArray, sql } from "@loxaic/db";
import { conversations, mcpServers, user } from "@loxaic/db/schema";
import { buildToolset } from "../registry.ts";

/**
 * Migration 0044 removes the built-in GitHub MCP server's rows. Its statement
 * is run here as written, scoped to this suite's own user so the shared
 * database's other rows are left alone.
 */
const migration = readFileSync(new URL("../../../../../packages/db/drizzle/0044_remove_github_mcp.sql", import.meta.url), "utf8");
const statement = migration
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .trim()
  .replace(/;\s*$/, "");

describe("migration 0044's removal of the built-in GitHub MCP server", () => {
  const ownerId = `test-mig44-${uuid()}`;
  // Slugs are unique per owner, so someone else's hand-made `github`.
  const otherId = `test-mig44-b-${uuid()}`;
  let builtinId = "";
  let handMadeId = "";
  let conversationId = "";

  beforeAll(async () => {
    for (const id of [ownerId, otherId]) {
      await db.insert(user).values({ id, name: "m", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    }
    const [builtin] = await db
      .insert(mcpServers)
      .values({ ownerId, name: "GitHub", slug: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", builtinKey: "github" })
      .returning();
    // Someone's own server that happens to use the slug — not ours to delete.
    const [handMade] = await db
      .insert(mcpServers)
      .values({ ownerId: otherId, name: "My GitHub", slug: "github", transport: "http", url: "https://example.test/mcp", enabled: false })
      .returning();
    builtinId = builtin.id;
    handMadeId = handMade.id;
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId, title: "m", kind: "agent", mcpOverrides: { enabledServerIds: [builtinId], disabledServerIds: [] } })
      .returning();
    conversationId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
    for (const id of [ownerId, otherId]) {
      await db.delete(mcpServers).where(eq(mcpServers.ownerId, id));
      await db.delete(user).where(eq(user.id, id));
    }
  });

  it("deletes the built-in row and keeps a hand-made one with the same slug", async () => {
    expect(statement).toMatch(/^DELETE FROM "mcp_servers" WHERE "builtin_key" = 'github'$/);
    await db.execute(sql.raw(`${statement} AND "owner_id" IN ('${ownerId}', '${otherId}')`));
    const left = await db.query.mcpServers.findMany({ where: inArray(mcpServers.ownerId, [ownerId, otherId]) });
    expect(left.map((r) => r.id)).toEqual([handMadeId]);
  });

  it("leaves a conversation that named the deleted server working", async () => {
    // Its mcp_overrides still names the deleted id.
    const toolset = await buildToolset(ownerId, { mode: "manual", conversationId });
    expect(toolset.openAiTools.some((t) => t.function.name === "bash")).toBe(true);
    expect(toolset.openAiTools.some((t) => t.function.name.startsWith("github__"))).toBe(false);
  });
});
