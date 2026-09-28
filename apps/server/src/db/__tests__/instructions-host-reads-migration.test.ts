import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { db, eq, inArray, sql } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock, ProjectInstructions, Workspace } from "@loxaic/types";

/**
 * Migration 0031 removes what the unconfined instructions reads may have
 * stored: a snapshot read through a symlink out of the workspace (or, for a
 * container-isolated folder, on the host), and the notices the per-run check
 * wrote the same way.
 *
 * It is the real file, statement by statement, the way the migrator splits
 * it, run inside a transaction that is always rolled back: the statements are
 * deployment-wide, and the database is shared with every other suite, so
 * nothing here may outlive the test.
 */
const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/db/drizzle/0031_instructions_host_reads.sql",
);

class Rollback extends Error {}

const found = (extra: Record<string, unknown> = {}): ProjectInstructions => ({
  status: "found", path: "AGENTS.md", text: "SECRET KEY", sourceBytes: 10, sourceTruncated: false,
  fetchedAt: "2026-09-28T00:00:00.000Z", ...extra,
});

const direct: Workspace = { kind: "local", executorId: "e", executorName: "Laptop", path: "/x", isolation: "direct" };
const isolated: Workspace = { ...direct, isolation: "container" };
const github: Workspace = {
  kind: "github", repo: "octo/real", baseBranch: "main", branch: "loxaic/x", cloneUrl: "https://github.example/octo/real.git",
};

describe("migration 0031: what the unconfined instructions reads stored", () => {
  it("clears exec-read snapshots and every notice, and keeps an API-read snapshot", async () => {
    const statements = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);

    const userId = `test-migration-0031-${uuid()}`;
    let after: { id: string; instructions: unknown }[] = [];
    let contents: Record<string, ContentBlock[]> = {};
    const ids: Record<string, string> = {};

    await db
      .transaction(async (tx) => {
        await tx.insert(user).values({
          id: userId, name: "Migration", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
        });
        const conv = async (name: string, workspace: Workspace, instructions: ProjectInstructions | null) => {
          const [row] = await tx.insert(conversations).values({ ownerId: userId, kind: "agent", workspace, instructions }).returning();
          ids[name] = row.id;
        };
        await conv("direct", direct, found());
        await conv("isolated", isolated, found({ cksums: { "AGENTS.md": "1 10" } }));
        await conv("githubApi", github, found());
        await conv("githubCheckout", github, found({ cksums: { "AGENTS.md": "1 10" } }));
        await conv("githubLatest", github, found({ latest: { path: "AGENTS.md", text: "SECRET", sourceBytes: 6, sourceTruncated: false } }));
        await conv("notLooked", direct, null);

        const msg = async (name: string, content: ContentBlock[]) => {
          const id = uuid();
          await tx.insert(messages).values({
            id, conversationId: ids.githubApi, authorType: "user", origin: "server", lamport: 1, content, status: "complete",
            createdAt: new Date(),
          });
          ids[name] = id;
        };
        await msg("withNotice", [
          { kind: "text", text: "say hello" },
          { kind: "instructions_update", path: "AGENTS.md", text: "SECRET", summary: "AGENTS.md: changed" },
        ] as ContentBlock[]);
        await msg("plain", [{ kind: "text", text: "just a message" }] as ContentBlock[]);

        for (const statement of statements) await tx.execute(sql.raw(statement));

        after = await tx
          .select({ id: conversations.id, instructions: conversations.instructions })
          .from(conversations)
          .where(eq(conversations.ownerId, userId));
        const rows = await tx
          .select({ id: messages.id, content: messages.content })
          .from(messages)
          .where(inArray(messages.id, [ids.withNotice, ids.plain]));
        contents = Object.fromEntries(rows.map((r) => [r.id, r.content as ContentBlock[]]));
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const byId = new Map(after.map((r) => [r.id, r.instructions]));
    expect(byId.get(ids.direct)).toBeNull();
    expect(byId.get(ids.isolated)).toBeNull();
    expect(byId.get(ids.githubCheckout)).toBeNull();
    expect(byId.get(ids.githubLatest)).toBeNull();
    // Read through GitHub's contents API, which serves nothing outside the repo.
    expect(byId.get(ids.githubApi)).toMatchObject({ status: "found", path: "AGENTS.md" });
    expect(byId.get(ids.notLooked)).toBeNull();

    expect(contents[ids.withNotice]).toEqual([{ kind: "text", text: "say hello" }]);
    expect(contents[ids.plain]).toEqual([{ kind: "text", text: "just a message" }]);

    // Rolled back: none of it reached the shared database.
    expect(await db.query.user.findFirst({ where: eq(user.id, userId) })).toBeUndefined();
  });
});
