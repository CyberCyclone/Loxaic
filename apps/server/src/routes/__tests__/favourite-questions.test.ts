import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { favouriteQuestions, user } from "@loxaic/db/schema";
import { DEFAULT_FAVOURITE_QUESTIONS, FAVOURITE_QUESTION_MAX_CHARS, MAX_FAVOURITE_QUESTIONS } from "@loxaic/types";

/**
 * `/v1/prefs/favourite-questions` through a real Fastify instance and the
 * shared database; only authentication is stubbed. Each case signs in as a
 * user of its own, so the defaults are given afresh and no case sees another's
 * rows.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { prefsRoutes } = await import("../prefs.ts");

interface Question {
  id: string;
  text: string;
  createdAt: string;
}

const app = Fastify();
prefsRoutes(app);
const created: string[] = [];

async function freshUser(): Promise<string> {
  const id = `test-favourites-${uuid()}`;
  await db.insert(user).values({
    id,
    name: "Test Favourites",
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  created.push(id);
  currentUser.id = id;
  return id;
}

const list = async () =>
  (await app.inject({ method: "GET", url: "/v1/prefs/favourite-questions" })).json<{ questions: Question[] }>().questions;
const add = (text: unknown) => app.inject({ method: "POST", url: "/v1/prefs/favourite-questions", payload: { text } });
const remove = (id: string) => app.inject({ method: "DELETE", url: `/v1/prefs/favourite-questions/${id}` });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  if (created.length) await db.delete(user).where(inArray(user.id, created));
  await app.close();
});

describe("favourite questions", () => {
  it("gives a new person the defaults, in order", async () => {
    await freshUser();
    expect((await list()).map((q) => q.text)).toEqual(DEFAULT_FAVOURITE_QUESTIONS);
  });

  it("gives the defaults once when the first requests race", async () => {
    const id = await freshUser();
    await Promise.all([list(), list(), list(), add("Raced in")]);
    const rows = await db.select().from(favouriteQuestions).where(eq(favouriteQuestions.userId, id));
    expect(rows).toHaveLength(DEFAULT_FAVOURITE_QUESTIONS.length + 1);
    expect((await list()).map((q) => q.text)).toEqual([...DEFAULT_FAVOURITE_QUESTIONS, "Raced in"]);
  });

  it("adds a question to the end, trimmed, and ignores one already there", async () => {
    await freshUser();
    const res = await add("  What should I cook tonight?  ");
    expect(res.statusCode).toBe(200);
    const after = res.json<{ questions: Question[] }>().questions;
    expect(after.at(-1)?.text).toBe("What should I cook tonight?");
    expect((await add("What should I cook tonight?")).statusCode).toBe(200);
    expect((await list()).filter((q) => q.text === "What should I cook tonight?")).toHaveLength(1);
  });

  it("refuses a blank, missing or too-long question", async () => {
    await freshUser();
    for (const text of ["", "   \n ", undefined, 42, "x".repeat(FAVOURITE_QUESTION_MAX_CHARS + 1)]) {
      const res = await add(text);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBeTruthy();
    }
    expect((await add("x".repeat(FAVOURITE_QUESTION_MAX_CHARS))).statusCode).toBe(200);
  });

  it("stops at the cap, even when the last places are raced for", async () => {
    await freshUser();
    const room = MAX_FAVOURITE_QUESTIONS - DEFAULT_FAVOURITE_QUESTIONS.length;
    for (let i = 0; i < room - 1; i++) expect((await add(`Question ${String(i)}`)).statusCode).toBe(200);
    const raced = await Promise.all([add("Last A"), add("Last B"), add("Last C")]);
    expect(raced.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
    expect(await list()).toHaveLength(MAX_FAVOURITE_QUESTIONS);
    // A question already there is still no change rather than "full".
    expect((await add("Question 0")).statusCode).toBe(200);
  });

  it("keeps an empty list once every question is removed", async () => {
    await freshUser();
    for (const q of await list()) expect((await remove(q.id)).statusCode).toBe(200);
    expect(await list()).toEqual([]);
    expect(await list()).toEqual([]);
  });

  it("answers another person's question and a malformed id with the same 404", async () => {
    await freshUser();
    const [theirs] = await list();
    await freshUser();
    const other = await remove(theirs.id);
    const malformed = await remove("not-an-id");
    const missing = await remove(uuid());
    for (const res of [other, malformed, missing]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(malformed.body);
    }
    const [owner] = created.slice(-2);
    const still = await db.select().from(favouriteQuestions).where(eq(favouriteQuestions.id, theirs.id));
    expect(still.map((r) => r.userId)).toEqual([owner]);
  });

  it("goes with the person", async () => {
    const id = await freshUser();
    await list();
    await db.delete(user).where(eq(user.id, id));
    expect(await db.select().from(favouriteQuestions).where(eq(favouriteQuestions.userId, id))).toEqual([]);
  });
});
