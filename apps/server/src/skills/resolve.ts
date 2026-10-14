/**
 * The catalog a request is answered from: the conversation owner's when a
 * conversation is named and the caller can see it, else the caller's own.
 * The same owner the run uses (skills/session.ts), so the palette offers
 * exactly what a send will find.
 */
import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import { NotFoundError, resolveAccess } from "../streams/authz.ts";
import { resolveSkillCatalog, type CatalogSkill } from "./catalog.ts";

export async function catalogForRequest(userId: string, conversationId?: string | null): Promise<CatalogSkill[]> {
  if (!conversationId) return resolveSkillCatalog({ ownerId: userId });
  const grant = await resolveAccess(userId, conversationId);
  if (!grant) throw new NotFoundError();
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { ownerId: true },
  });
  if (!row) throw new NotFoundError();
  return resolveSkillCatalog({ ownerId: row.ownerId, conversationId });
}

/** What a `command.run` names: the built-in compaction only when the name
 * resolves to it. A person who added their own skill called "compact" has
 * replaced it, and their client sends "/compact" as a message instead. */
export async function resolveCommandSkill(
  userId: string,
  conversationId: string | null | undefined,
  name: string,
): Promise<CatalogSkill | undefined> {
  const catalog = await catalogForRequest(userId, conversationId);
  return catalog.find((s) => s.name === name.toLowerCase());
}
