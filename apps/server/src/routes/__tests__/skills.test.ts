import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray, sql } from "@loxaic/db";
import { conversations, conversationShares, skills, user, userPrefs } from "@loxaic/db/schema";
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
  await db.delete(skills).where(inArray(skills.ownerId, [owner, stranger]));
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

  it("lists the owner's own skills only to someone who can send into the thread", async () => {
    // A person's skills are theirs: a viewer, and every admin (who resolves
    // to one), sees a thread, not the catalog of whoever owns it.
    await db.insert(skills).values({ ownerId: owner, name: "owners-secret", description: "Only the owner's.", body: "x" });
    const share = { conversationId: convId, userId: stranger, createdBy: owner };
    await db.insert(conversationShares).values({ ...share, role: "viewer" });
    try {
      currentUser.id = stranger;
      const asViewer = await list(`?conversation_id=${convId}`);
      expect(asViewer.status).toBe(200);
      expect(asViewer.skills.map((s) => s.name)).not.toContain("owners-secret");
      expect(asViewer.skills.map((s) => s.name)).toContain("debug");

      await db.update(conversationShares).set({ role: "editor" }).where(eq(conversationShares.userId, stranger));
      expect((await list(`?conversation_id=${convId}`)).skills.map((s) => s.name)).toContain("owners-secret");
    } finally {
      await db.delete(conversationShares).where(eq(conversationShares.userId, stranger));
      await db.delete(skills).where(eq(skills.ownerId, owner));
    }
  });

  it("answers 404 for a conversation the caller cannot see, or that is not an id", async () => {
    currentUser.id = stranger;
    expect((await list(`?conversation_id=${convId}`)).status).toBe(404);
    expect((await list("?conversation_id=c12345")).status).toBe(404);
  });
});

interface Mine {
  builtin: { name: string; overriddenBy: string | null; body: string; action?: string }[];
  mine: { id: string; name: string; description: string; body: string; modelInvocable: boolean; overridesBuiltin: boolean }[];
}

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body: Record<string, unknown> = res.json();
  return { status: res.statusCode, body };
}

describe("/v1/skills/mine", () => {
  it("creates a skill, which then appears in the palette as the caller's own", async () => {
    currentUser.id = owner;
    const created = await call("POST", "/v1/skills/mine", {
      name: "house-style", description: "How we write.  Use it   always.", body: "  Short sentences.  ",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "house-style", description: "How we write. Use it always.", body: "Short sentences.", modelInvocable: true, overridesBuiltin: false });
    const { skills: listed } = await list();
    expect(listed.find((s) => s.name === "house-style")).toMatchObject({ source: "user" });
  });

  it("refuses what the format would refuse, and a name the caller already has", async () => {
    currentUser.id = owner;
    for (const bad of [
      { name: "Has Caps", description: "d", body: "b" },
      { name: "-edge", description: "d", body: "b" },
      { name: "ok", description: "  ", body: "b" },
      { name: "ok", description: "d", body: "" },
      { name: "ok", description: "d".repeat(1025), body: "b" },
    ]) {
      expect((await call("POST", "/v1/skills/mine", bad)).status).toBe(400);
    }
    expect((await call("POST", "/v1/skills/mine", { name: "house-style", description: "d", body: "b" })).status).toBe(409);
  });

  it("overrides a built-in by name, says so on both sides, and restores it when deleted", async () => {
    currentUser.id = owner;
    const created = await call("POST", "/v1/skills/mine", { name: "code-review", description: "Our review.", body: "Check our rules." });
    expect(created.body.overridesBuiltin).toBe(true);
    const mine = (await call("GET", "/v1/skills/mine")).body as unknown as Mine;
    expect(mine.builtin.find((b) => b.name === "code-review")?.overriddenBy).toBe(created.body.id);
    expect(mine.builtin.find((b) => b.name === "debug")?.overriddenBy).toBeNull();
    const palette = (await list()).skills.filter((s) => s.name === "code-review");
    expect(palette).toEqual([expect.objectContaining({ source: "user", description: "Our review." })]);

    expect((await call("DELETE", `/v1/skills/mine/${String(created.body.id)}`)).status).toBe(200);
    expect((await list()).skills.find((s) => s.name === "code-review")?.source).toBe("builtin");
  });

  it("replaces compact with a skill, which the palette then offers as a message, not an action", async () => {
    currentUser.id = owner;
    const created = await call("POST", "/v1/skills/mine", { name: "compact", description: "Ours.", body: "Summarise our way." });
    const compact = (await list()).skills.find((s) => s.name === "compact");
    expect(compact?.action).toBeUndefined();
    expect(compact?.source).toBe("user");
    await call("DELETE", `/v1/skills/mine/${String(created.body.id)}`);
    expect((await list()).skills.find((s) => s.name === "compact")?.action).toBe("compact");
  });

  it("edits only what is sent, and refuses a rename onto another of the caller's skills", async () => {
    currentUser.id = owner;
    const a = await call("POST", "/v1/skills/mine", { name: "alpha", description: "A.", body: "a" });
    await call("POST", "/v1/skills/mine", { name: "bravo", description: "B.", body: "b" });
    const edited = await call("PATCH", `/v1/skills/mine/${String(a.body.id)}`, { body: "new body", modelInvocable: false });
    expect(edited.body).toMatchObject({ name: "alpha", description: "A.", body: "new body", modelInvocable: false });
    expect((await call("PATCH", `/v1/skills/mine/${String(a.body.id)}`, { name: "bravo" })).status).toBe(409);
    expect((await call("PATCH", `/v1/skills/mine/${String(a.body.id)}`, {})).status).toBe(400);
  });

  /** Runs `act` with a trigger on `skills` that fires only for this test's
   * rows, so parallel suites are untouched. A trigger, because `db` is a
   * proxy no spy reaches, and because it puts the race exactly between the
   * route's check and its write. */
  async function withTrigger<T>(timing: string, when: string, body: string, act: () => Promise<T>): Promise<T> {
    const name = `skills_race_${uuid().replaceAll("-", "_")}`;
    await db.execute(
      sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
        CREATE TRIGGER ${name} ${timing} ON skills FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}();`),
    );
    try {
      return await act();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON skills; DROP FUNCTION ${name}();`));
    }
  }

  it("answers 409, not 500, when another save takes the name between the check and the write", async () => {
    // Two saves at once both find the name free; the (owner_id, name) index
    // refuses the second, which must still read as the name being taken.
    currentUser.id = owner;
    const insertFirst = `INSERT INTO skills (owner_id, name, description, body) VALUES (NEW.owner_id, NEW.name, 'first', 'x'); RETURN NEW;`;
    const created = await withTrigger("BEFORE INSERT", `NEW.owner_id = '${owner}' AND NEW.description = 'racing'`, insertFirst, () =>
      call("POST", "/v1/skills/mine", { name: "raced", description: "racing", body: "b" }),
    );
    expect(created).toEqual({ status: 409, body: { error: 'You already have a skill called "raced".' } });

    const other = await call("POST", "/v1/skills/mine", { name: "renamed-later", description: "R.", body: "b" });
    const renamed = await withTrigger("BEFORE UPDATE", `NEW.id = '${String(other.body.id)}'`, insertFirst, () =>
      call("PATCH", `/v1/skills/mine/${String(other.body.id)}`, { name: "taken-meanwhile" }),
    );
    expect(renamed).toEqual({ status: 409, body: { error: 'You already have a skill called "taken-meanwhile".' } });
  });

  it("answers 404, not 500, for an edit to a skill deleted since it was found", async () => {
    // Another device deletes it between the route's lookup and its update,
    // which then matches nothing. The trigger skips the row, as that would.
    currentUser.id = owner;
    const made = await call("POST", "/v1/skills/mine", { name: "vanishing", description: "V.", body: "b" });
    const edited = await withTrigger("BEFORE UPDATE", `OLD.id = '${String(made.body.id)}'`, "RETURN NULL;", () =>
      call("PATCH", `/v1/skills/mine/${String(made.body.id)}`, { body: "changed" }),
    );
    expect(edited).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("answers 404 for someone else's skill, and changes nothing", async () => {
    currentUser.id = owner;
    const own = await call("POST", "/v1/skills/mine", { name: "private", description: "P.", body: "p" });
    currentUser.id = stranger;
    expect((await call("PATCH", `/v1/skills/mine/${String(own.body.id)}`, { body: "x" })).status).toBe(404);
    expect((await call("DELETE", `/v1/skills/mine/${String(own.body.id)}`)).status).toBe(404);
    expect((await call("DELETE", "/v1/skills/mine/not-an-id")).status).toBe(404);
    expect(((await call("GET", "/v1/skills/mine")).body as unknown as Mine).mine).toEqual([]);
    currentUser.id = owner;
    expect(((await call("GET", "/v1/skills/mine")).body as unknown as Mine).mine.find((s) => s.name === "private")?.body).toBe("p");
  });

  it("goes with its owner", async () => {
    const gone = `test-skillroute-gone-${uuid()}`;
    await db.insert(user).values({ id: gone, name: gone, email: `${gone}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    currentUser.id = gone;
    await call("POST", "/v1/skills/mine", { name: "doomed", description: "D.", body: "d" });
    await db.delete(user).where(eq(user.id, gone));
    expect(await db.query.skills.findFirst({ where: eq(skills.ownerId, gone) })).toBeUndefined();
  });
});
