import { ADMIN_EMAIL } from "./force-admin-emails.ts";
import { afterAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, eq, inArray } from "@shannon/db";
import { account, session, user } from "@shannon/db/schema";
import { auth } from "../index.ts";
import { requireAdmin } from "../middleware.ts";

const PASSWORD = "password123";
const emails: string[] = [];

function fakeReply() {
  const calls: { code?: number; body?: unknown } = {};
  const reply = {
    code(c: number) {
      calls.code = c;
      return reply;
    },
    send(body: unknown) {
      calls.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, calls };
}

function requestWithToken(token: string | null): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

async function signUp(email: string) {
  emails.push(email);
  return auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: "Test User" },
  });
}

describe("admin role", () => {
  it("grants admin to an email listed in ADMIN_EMAILS", async () => {
    const res = await signUp(ADMIN_EMAIL);
    expect(res.user.role).toBe("admin");
  });

  it("does not grant admin to an unlisted email once other users already exist", async () => {
    // ADMIN_EMAIL above guarantees the user count is > 0 by this point, so
    // this only exercises the ADMIN_EMAILS branch, not the first-user branch
    // (asserting the true "first ever user" case is inherently racy against
    // other test files sharing this DB and is not attempted here).
    const email = `not-admin-${uuid()}@example.test`;
    const res = await signUp(email);
    expect(res.user.role == null || res.user.role === "user").toBe(true);
  });

  it("requireAdmin: 401 with no authorization header", async () => {
    const { reply, calls } = fakeReply();
    await expect(requireAdmin(requestWithToken(null), reply)).rejects.toThrow();
    expect(calls.code).toBe(401);
  });

  it("requireAdmin: 403 for a non-admin session", async () => {
    const email = `requireadmin-nonadmin-${uuid()}@example.test`;
    const signUpRes = await signUp(email);
    const { reply, calls } = fakeReply();
    await expect(requireAdmin(requestWithToken(signUpRes.token), reply)).rejects.toThrow();
    expect(calls.code).toBe(403);
  });

  it("requireAdmin: resolves with the user id for an admin session", async () => {
    // Reuses the ADMIN_EMAIL user from the first test (signing in, not up) —
    // ADMIN_EMAILS is a Set frozen at module load, so granting a *new* email
    // admin at test runtime wouldn't take effect.
    const signInRes = await auth.api.signInEmail({ body: { email: ADMIN_EMAIL, password: PASSWORD } });
    const { reply, calls } = fakeReply();
    const userId = await requireAdmin(requestWithToken(signInRes.token), reply);
    expect(userId).toBe(signInRes.user.id);
    expect(calls.code).toBeUndefined();
  });
});

afterAll(async () => {
  const rows = await db.query.user.findMany({ where: inArray(user.email, emails) });
  const userIds = rows.map((r) => r.id);
  if (userIds.length) {
    await db.delete(session).where(inArray(session.userId, userIds));
    await db.delete(account).where(inArray(account.userId, userIds));
  }
  for (const email of emails) {
    await db.delete(user).where(eq(user.email, email));
  }
});
