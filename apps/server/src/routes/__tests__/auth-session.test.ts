import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";
import { auth } from "../../auth/index.ts";
import { authRoutes } from "../auth.ts";

/**
 * `GET /api/auth/session` is served outside the auth middleware, so the ban it
 * enforces everywhere else has to be enforced here too — this is the route a
 * client asks when its socket is refused, and at every launch.
 */
const app = Fastify();
authRoutes(app);
const userIds: string[] = [];

async function signUp() {
  const email = `session-${uuid()}@example.test`;
  const res = await auth.api.signUpEmail({ body: { email, password: "password123", name: "Session Test" } });
  userIds.push(res.user.id);
  return { id: res.user.id, token: res.token ?? "" };
}

const getSession = (token: string) =>
  app.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: `Bearer ${token}` } });

describe("GET /api/auth/session", () => {
  it("answers with the user for a live session", async () => {
    const u = await signUp();
    const res = await getSession(u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { id: string } }>().user.id).toBe(u.id);
  });

  it("401s a session whose user was banned after it was created", async () => {
    const u = await signUp();
    await db.update(user).set({ banned: true, banExpires: null }).where(eq(user.id, u.id));
    const res = await getSession(u.token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "account_suspended" });
  });

  it("answers again once the ban has expired", async () => {
    const u = await signUp();
    await db.update(user).set({ banned: true, banExpires: new Date(Date.now() - 60_000) }).where(eq(user.id, u.id));
    expect((await getSession(u.token)).statusCode).toBe(200);
  });

  it("still answers a user who must change their password: that screen depends on it", async () => {
    const u = await signUp();
    await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, u.id));
    const res = await getSession(u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { mustChangePassword: boolean } }>().user.mustChangePassword).toBe(true);
  });

  it("401s without a session", async () => {
    expect((await getSession("not-a-token")).statusCode).toBe(401);
  });
});

afterAll(async () => {
  if (userIds.length === 0) return;
  await db.delete(session).where(inArray(session.userId, userIds));
  await db.delete(account).where(inArray(account.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
});
