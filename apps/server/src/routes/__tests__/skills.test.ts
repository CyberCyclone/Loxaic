import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, user, userPrefs } from "@loxaic/db/schema";
import type { PaletteSkill } from "@loxaic/types";

/**
 * `GET /v1/skills`, what the composer's "/" palette lists (#283): every skill,
 * most-used first by the caller's own counts, and nothing at all for a
 * conversation the caller cannot see.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

const { skillRoutes } = await import("../skills.ts");
const { recordSkillUse } = await import("../../skills/usage.ts");

const owner = `test-skillroute-${uuid()}`;
const stranger = `test-skillroute-x-${uuid()}`;
const app = Fastify();
skillRoutes(app);
let convId = "";

beforeAll(async () => {
  for (const id of [owner, stranger]) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }
  const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "t" }).returning();
  convId = conv.id;
});

afterAll(async () => {
  await app.close();
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(userPrefs).where(inArray(userPrefs.userId, [owner, stranger]));
  await db.delete(user).where(inArray(user.id, [owner, stranger]));
});

async function list(query = ""): Promise<{ status: number; skills: PaletteSkill[] }> {
  const res = await app.inject({ method: "GET", url: `/v1/skills${query}` });
  const body: { skills?: PaletteSkill[] } = res.json();
  return { status: res.statusCode, skills: body.skills ?? [] };
}

describe("GET /v1/skills", () => {
  it("lists every built-in, compact included as an action", async () => {
    currentUser.id = owner;
    const { status, skills } = await list();
    expect(status).toBe(200);
    expect(skills.map((s) => s.name).sort()).toEqual(
      ["code-review", "commit", "compact", "create-skill", "debug", "pr-description", "security-review", "write-tests"],
    );
    expect(skills.find((s) => s.name === "compact")).toMatchObject({ action: "compact", argHint: "[guidance]" });
  });

  it("puts what the caller uses most first, by their own counts only", async () => {
    currentUser.id = owner;
    await recordSkillUse(owner, "debug");
    await recordSkillUse(owner, "debug");
    await recordSkillUse(owner, "commit");
    const { skills } = await list(`?conversation_id=${convId}`);
    expect(skills.slice(0, 2).map((s) => [s.name, s.uses])).toEqual([["debug", 2], ["commit", 1]]);

    currentUser.id = stranger;
    expect((await list()).skills[0].uses).toBe(0);
  });

  it("answers 404 for a conversation the caller cannot see, or that is not an id", async () => {
    currentUser.id = stranger;
    expect((await list(`?conversation_id=${convId}`)).status).toBe(404);
    expect((await list("?conversation_id=c12345")).status).toBe(404);
  });
});
