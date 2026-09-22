import { ADMIN_EMAIL } from "./force-admin-emails.ts";
import { afterAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";
import { auth } from "../index.ts";
import { authenticate, authenticateForPasswordChange, requireAdmin, resolveSessionFromToken } from "../middleware.ts";

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

/**
 * better-auth only checks `banned` when a session is created, and its own ban
 * endpoints delete the user's sessions — so the gap these cover is a ban
 * applied *out of band* (a direct SQL UPDATE, the shape of the documented
 * role-promotion recovery path), which leaves live sessions untouched and
 * would otherwise never be enforced anywhere.
 */
describe("ban enforcement on the read path", () => {
  async function signUpThenBan(opts: { banExpires?: Date | null; role?: string } = {}) {
    const email = `banned-${uuid()}@example.test`;
    const res = await signUp(email);
    await db
      .update(user)
      .set({
        banned: true,
        banReason: "test",
        banExpires: opts.banExpires ?? null,
        ...(opts.role ? { role: opts.role } : {}),
      })
      .where(eq(user.id, res.user.id));
    return res;
  }

  it("authenticate: 403 for a session whose user was banned after signing in", async () => {
    const res = await signUpThenBan();
    const { reply, calls } = fakeReply();
    await expect(authenticate(requestWithToken(res.token), reply)).rejects.toThrow();
    expect(calls.code).toBe(403);
  });

  it("requireAdmin: 403 for a banned *admin* — the ban outranks the role", async () => {
    // Deliberately an admin: a banned non-admin would be rejected for the
    // role anyway, so it would pass this test even with ban enforcement
    // removed entirely (confirmed — that's why this grants admin first).
    const res = await signUpThenBan({ role: "admin" });
    const { reply, calls } = fakeReply();
    await expect(requireAdmin(requestWithToken(res.token), reply)).rejects.toThrow();
    expect(calls.code).toBe(403);
    expect(calls.body).toEqual({ error: "Account suspended" });
  });

  it("treats an expired ban as lifted, mirroring better-auth's auto-unban", async () => {
    const res = await signUpThenBan({ banExpires: new Date(Date.now() - 60_000) });
    const { reply, calls } = fakeReply();
    await expect(authenticate(requestWithToken(res.token), reply)).resolves.toBe(res.user.id);
    expect(calls.code).toBeUndefined();
  });

  it("leaves an unbanned user alone", async () => {
    const email = `not-banned-${uuid()}@example.test`;
    const res = await signUp(email);
    const { reply, calls } = fakeReply();
    await expect(authenticate(requestWithToken(res.token), reply)).resolves.toBe(res.user.id);
    expect(calls.code).toBeUndefined();
  });
});

describe("forced password change", () => {
  // Set the flag the way a reset does, without the reset's session purge, so
  // the token in hand is still a live session for a flagged user.
  const flag = (id: string, extra: Partial<typeof user.$inferInsert> = {}) =>
    db.update(user).set({ mustChangePassword: true, ...extra }).where(eq(user.id, id));

  it("refuses every authenticated route with a recognisable 403", async () => {
    const res = await signUp(`must-change-${uuid()}@example.test`);
    await flag(res.user.id);
    const { reply, calls } = fakeReply();
    await expect(authenticate(requestWithToken(res.token), reply)).rejects.toThrow();
    expect(calls.code).toBe(403);
    expect(calls.body).toMatchObject({ code: "password_change_required" });
  });

  it("refuses sockets too", async () => {
    const res = await signUp(`must-change-ws-${uuid()}@example.test`);
    await flag(res.user.id);
    await expect(resolveSessionFromToken(res.token ?? "")).resolves.toBeNull();
  });

  it("outranks the admin role", async () => {
    const res = await signUp(`must-change-admin-${uuid()}@example.test`);
    await flag(res.user.id, { role: "admin" });
    const { reply, calls } = fakeReply();
    await expect(requireAdmin(requestWithToken(res.token), reply)).rejects.toThrow();
    expect(calls.code).toBe(403);
    expect(calls.body).toMatchObject({ code: "password_change_required" });
  });

  it("is let through by the change-password gate, and nothing else", async () => {
    const res = await signUp(`must-change-gate-${uuid()}@example.test`);
    await flag(res.user.id);
    const { reply, calls } = fakeReply();
    const session = await authenticateForPasswordChange(requestWithToken(res.token), reply);
    expect(session.user.id).toBe(res.user.id);
    expect(calls.code).toBeUndefined();
  });

  it("a ban is reported as a ban, even when the flag is also set", async () => {
    const res = await signUp(`must-change-banned-${uuid()}@example.test`);
    await flag(res.user.id, { banned: true });
    for (const gate of [authenticate, authenticateForPasswordChange]) {
      const { reply, calls } = fakeReply();
      await expect(gate(requestWithToken(res.token), reply)).rejects.toThrow();
      expect(calls.code).toBe(403);
      expect(calls.body).toEqual({ error: "Account suspended" });
    }
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
