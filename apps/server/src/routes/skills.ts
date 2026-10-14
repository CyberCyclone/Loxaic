import type { FastifyInstance } from "fastify";
import { and, asc, count, db, eq } from "@loxaic/db";
import { skills } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { NotFoundError } from "../streams/authz.ts";
import { builtinCatalogSkills, paletteSkills } from "../skills/catalog.ts";
import { catalogForRequest } from "../skills/resolve.ts";
import { getSkillUsage } from "../skills/usage.ts";
import { MAX_USER_SKILLS, validateSkillInput } from "../skills/user-skills.ts";

/**
 * Skills (#283) — see apps/server/src/skills/AGENTS.md.
 *
 * `GET /v1/skills` is what the composer's "/" palette lists: every skill the
 * caller can run in the named conversation (its owner's, as a send resolves
 * them), or their own when none is named, most-used first by the caller's own
 * counts. The order is the server's so every client lists the same thing.
 *
 * `/v1/skills/mine` is the Skills screen: the built-ins, read-only, each with
 * the id of the caller's own skill that supersedes it, if any; and the
 * caller's own skills, which they create, edit and delete. Nothing can change
 * a built-in — a skill of the same name is how a person replaces one.
 */
export function skillRoutes(app: FastifyInstance) {
  app.get("/v1/skills", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id: conversationId } = request.query as { conversation_id?: string };
    try {
      const [catalog, usage] = await Promise.all([
        catalogForRequest(userId, conversationId),
        getSkillUsage(userId),
      ]);
      return { skills: paletteSkills(catalog, usage) };
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: "Not found" };
      }
      throw err;
    }
  });

  app.get("/v1/skills/mine", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const mine = await db.select().from(skills).where(eq(skills.ownerId, userId)).orderBy(asc(skills.name));
    const byName = new Map(mine.map((s) => [s.name, s.id]));
    return {
      builtin: builtinCatalogSkills().map((s) => ({
        name: s.name,
        description: s.description,
        body: s.body,
        modelInvocable: s.modelInvocable,
        ...(s.argHint ? { argHint: s.argHint } : {}),
        ...(s.action ? { action: s.action } : {}),
        overriddenBy: byName.get(s.name) ?? null,
      })),
      mine: mine.map(publicSkill),
    };
  });

  app.post("/v1/skills/mine", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const input = validateSkillInput(request.body, false);
    if (!input.ok) {
      reply.code(400);
      return { error: input.error };
    }
    const [{ n }] = await db.select({ n: count() }).from(skills).where(eq(skills.ownerId, userId));
    if (n >= MAX_USER_SKILLS) {
      reply.code(409);
      return { error: `You can have at most ${String(MAX_USER_SKILLS)} skills. Delete one to add another.` };
    }
    const { name = "", description = "", body = "", modelInvocable = true } = input.value;
    const clash = await nameTaken(userId, name);
    if (clash) {
      reply.code(409);
      return { error: `You already have a skill called "${name}".` };
    }
    let row;
    try {
      [row] = await db.insert(skills).values({ ownerId: userId, name, description, body, modelInvocable }).returning();
    } catch (err) {
      // Two saves at once both found the name free; the index decided.
      if (!isUniqueViolation(err)) throw err;
      reply.code(409);
      return { error: `You already have a skill called "${name}".` };
    }
    reply.code(201);
    return publicSkill(row);
  });

  app.patch("/v1/skills/mine/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { id } = request.params as { id: string };
    const existing = await findOwned(id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    const input = validateSkillInput(request.body, true);
    if (!input.ok) {
      reply.code(400);
      return { error: input.error };
    }
    if (input.value.name && input.value.name !== existing.name && (await nameTaken(userId, input.value.name))) {
      reply.code(409);
      return { error: `You already have a skill called "${input.value.name}".` };
    }
    let rows;
    try {
      rows = await db
        .update(skills)
        .set({ ...input.value, updatedAt: new Date() })
        .where(and(eq(skills.id, existing.id), eq(skills.ownerId, userId)))
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      reply.code(409);
      return { error: `You already have a skill called "${input.value.name ?? existing.name}".` };
    }
    // Deleted since it was found (another device, another tab): the same
    // answer as a skill that was never there.
    const row = rows.at(0);
    if (!row) {
      reply.code(404);
      return { error: "Not found" };
    }
    return publicSkill(row);
  });

  app.delete("/v1/skills/mine/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { id } = request.params as { id: string };
    const existing = await findOwned(id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    await db.delete(skills).where(and(eq(skills.id, existing.id), eq(skills.ownerId, userId)));
    return { ok: true };
  });
}

/** The `(owner_id, name)` index refusing a name: what a save that raced
 * another one past `nameTaken` gets, answered as the same 409. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Not yours and not there answer the same; an id that is not one is neither. */
async function findOwned(id: string, userId: string) {
  if (!UUID_RE.test(id)) return undefined;
  return db.query.skills.findFirst({ where: and(eq(skills.id, id), eq(skills.ownerId, userId)) });
}

async function nameTaken(userId: string, name: string): Promise<boolean> {
  const row = await db.query.skills.findFirst({
    where: and(eq(skills.ownerId, userId), eq(skills.name, name)),
    columns: { id: true },
  });
  return row !== undefined;
}

/** A row as the client sees it, with whether it supersedes a built-in. */
function publicSkill(row: typeof skills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    modelInvocable: row.modelInvocable,
    overridesBuiltin: builtinCatalogSkills().some((b) => b.name === row.name),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
