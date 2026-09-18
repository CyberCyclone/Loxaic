import { and, db, eq, isNull } from "@loxaic/db";
import { githubConnections, mcpServers } from "@loxaic/db/schema";
import { catalogEntry, GITHUB_BUILTIN_KEY, GITHUB_MCP_DEFAULT_URL, type HttpCatalogEntry } from "./catalog.ts";
import { closeServerClients } from "./client-manager.ts";

/**
 * The GitHub MCP server follows the user's GitHub connection: connecting a
 * token provisions it, disconnecting removes it, and a token re-issued through
 * the same screen is picked up without the user touching the MCP screen.
 *
 * The row stores no credential. `client-manager.ts` reads the owner's token
 * through `getOwnerToken()` when it connects, so there is exactly one copy of
 * the token to rotate or revoke. Everything that creates or deletes this row
 * lives here.
 */

export type GithubMcpStatus =
  | { ok: true; serverId: string; enabled: boolean }
  | { ok: false; error: string };

export const GITHUB_SLUG_TAKEN =
  'An MCP server with the slug "github" already exists. Rename or remove it under MCP Servers, then reconnect GitHub.';

function githubEntry(): HttpCatalogEntry {
  const entry = catalogEntry(GITHUB_BUILTIN_KEY);
  if (entry?.transport !== "http") throw new Error("GitHub catalog entry is missing");
  return entry;
}

async function findGithubRow(userId: string) {
  return db.query.mcpServers.findFirst({
    where: and(eq(mcpServers.ownerId, userId), eq(mcpServers.builtinKey, GITHUB_BUILTIN_KEY)),
  });
}

async function slugTaken(userId: string): Promise<boolean> {
  const entry = githubEntry();
  const row = await db.query.mcpServers.findFirst({
    where: and(eq(mcpServers.ownerId, userId), eq(mcpServers.slug, entry.slug)),
  });
  return row !== undefined;
}

/**
 * Create the user's GitHub MCP row, or refresh the one they have.
 *
 * Refreshing bumps `updatedAt`, which is the stamp `client-manager.ts`
 * reconnects on, and closes live connections outright — the token behind them
 * may just have changed. A hand-made server already using the `github` slug is
 * left alone and reported, never renamed or taken over.
 */
export async function ensureGithubMcpServer(userId: string): Promise<GithubMcpStatus> {
  const existing = await findGithubRow(userId);
  if (existing) {
    await db.update(mcpServers).set({ updatedAt: new Date() }).where(eq(mcpServers.id, existing.id));
    await closeServerClients(existing.id);
    return { ok: true, serverId: existing.id, enabled: existing.enabled };
  }

  const entry = githubEntry();
  const [inserted] = (await db
    .insert(mcpServers)
    .values({
      ownerId: userId,
      name: entry.name,
      slug: entry.slug,
      transport: entry.transport,
      // Descriptive only: client-manager.ts resolves the address from the
      // catalog at connect time, so an environment override (a test's mock)
      // is never frozen into a row other server processes will read.
      url: GITHUB_MCP_DEFAULT_URL,
      allowPrivateNetwork: false,
      builtinKey: entry.key,
      enabled: true,
    })
    .onConflictDoNothing({ target: [mcpServers.ownerId, mcpServers.slug] })
    // Drizzle's `.returning()` type doesn't reflect that a skipped conflict
    // yields zero rows — cast to what actually comes back.
    .returning()) as (typeof mcpServers.$inferSelect | undefined)[];
  if (inserted) return { ok: true, serverId: inserted.id, enabled: inserted.enabled };

  // Nothing inserted: either a concurrent connect won the race (its row is the
  // one we want), or the slug belongs to a server the user made by hand.
  const winner = await findGithubRow(userId);
  if (winner) return { ok: true, serverId: winner.id, enabled: winner.enabled };
  return { ok: false, error: GITHUB_SLUG_TAKEN };
}

/** Remove the user's GitHub MCP row, closing any live connection first. */
export async function removeGithubMcpServer(userId: string): Promise<void> {
  const row = await findGithubRow(userId);
  if (!row) return;
  await closeServerClients(row.id);
  await db.delete(mcpServers).where(eq(mcpServers.id, row.id));
}

/** What the GitHub screen should say about the tools, without changing anything. */
export async function describeGithubMcp(userId: string): Promise<GithubMcpStatus> {
  const row = await findGithubRow(userId);
  if (row) return { ok: true, serverId: row.id, enabled: row.enabled };
  if (await slugTaken(userId)) return { ok: false, error: GITHUB_SLUG_TAKEN };
  return { ok: false, error: "GitHub tools are not set up. Disconnect and reconnect GitHub to set them up." };
}

/**
 * Provision the row for every connection that has none — the users who
 * connected GitHub before this existed. Run once at boot; safe to run on
 * several instances at once, since `ensureGithubMcpServer` converges on one row.
 * Returns how many rows were created.
 */
export async function backfillGithubMcpServers(
  log: (message: string) => void = console.warn,
  /** Narrow the sweep to one user. Production never passes it; a test must,
   * because suites share one database and an unscoped backfill run from a
   * test provisions every developer's connection against that test's mock
   * URL — which is exactly what the first draft of this test did. */
  ownerId?: string,
): Promise<number> {
  const missingRow = isNull(mcpServers.id);
  const missing = await db
    .select({ userId: githubConnections.userId })
    .from(githubConnections)
    .leftJoin(
      mcpServers,
      and(eq(mcpServers.ownerId, githubConnections.userId), eq(mcpServers.builtinKey, GITHUB_BUILTIN_KEY)),
    )
    .where(ownerId ? and(missingRow, eq(githubConnections.userId, ownerId)) : missingRow);

  let created = 0;
  for (const { userId } of missing) {
    try {
      const status = await ensureGithubMcpServer(userId);
      if (status.ok) created++;
      else log(`GitHub MCP server not provisioned for user ${userId}: ${status.error}`);
    } catch (err) {
      log(`GitHub MCP server not provisioned for user ${userId}: ${(err as Error).message}`);
    }
  }
  return created;
}
