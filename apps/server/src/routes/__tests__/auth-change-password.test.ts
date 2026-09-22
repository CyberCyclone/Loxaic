import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";
import { auth } from "../../auth/index.ts";
import { resetUserPassword } from "../../auth/password-reset.ts";
import { authRoutes } from "../auth.ts";

/**
 * `POST /api/auth/change-password` through a real Fastify instance and real
 * better-auth. The contract a client depends on: better-auth's error `code`
 * arrives intact, success hands back a *new* token (every session, this one
 * included, is revoked), and the forced-change flag is cleared.
 */
const app = Fastify();
authRoutes(app);
const userIds: string[] = [];
const PASSWORD = "password123";

async function signUp() {
  const email = `change-pw-${uuid()}@example.test`;
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Change Test" } });
  userIds.push(res.user.id);
  return { email, id: res.user.id, token: res.token ?? "" };
}

const change = (token: string | null, body: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object,
  });

const sessionStatus = async (token: string) =>
  (await app.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: `Bearer ${token}` } })).statusCode;

describe("POST /api/auth/change-password", () => {
  it("400s without both passwords", async () => {
    const u = await signUp();
    expect((await change(u.token, { currentPassword: PASSWORD })).statusCode).toBe(400);
    expect((await change(u.token, { newPassword: "x".repeat(10), currentPassword: 7 })).statusCode).toBe(400);
  });

  it("401s without a session", async () => {
    expect((await change(null, { currentPassword: "a", newPassword: "bbbbbbbbbb" })).statusCode).toBe(401);
  });

  it("forwards better-auth's own error codes", async () => {
    const u = await signUp();
    const wrong = await change(u.token, { currentPassword: "not-it-at-all", newPassword: "new-password-1" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "INVALID_PASSWORD" });
    const short = await change(u.token, { currentPassword: PASSWORD, newPassword: "short" });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
  });

  it("refuses to keep the current password, so a reset cannot be satisfied with the temporary one", async () => {
    const u = await signUp();
    const { temporaryPassword } = await resetUserPassword(u.id);
    const signedIn = await auth.api.signInEmail({ body: { email: u.email, password: temporaryPassword } });
    const res = await change(signedIn.token, { currentPassword: temporaryPassword, newPassword: temporaryPassword });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "PASSWORD_UNCHANGED" });
    const [row] = await db.select({ flag: user.mustChangePassword }).from(user).where(eq(user.id, u.id));
    expect(row.flag).toBe(true);
    expect(await sessionStatus(signedIn.token)).toBe(200);
  });

  it("returns a new token and revokes every old session, this one included", async () => {
    const u = await signUp();
    const other = await auth.api.signInEmail({ body: { email: u.email, password: PASSWORD } });
    const res = await change(u.token, { currentPassword: PASSWORD, newPassword: "new-password-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; user: { id: string } }>();
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(u.token);
    expect(await sessionStatus(u.token)).toBe(401);
    expect(await sessionStatus(other.token)).toBe(401);
    expect(await sessionStatus(body.token)).toBe(200);
  });

  it("clears the forced-change flag, and lets a flagged user through to do it", async () => {
    const u = await signUp();
    const { temporaryPassword } = await resetUserPassword(u.id);
    const signedIn = await auth.api.signInEmail({ body: { email: u.email, password: temporaryPassword } });
    const res = await change(signedIn.token, { currentPassword: temporaryPassword, newPassword: "chosen-by-me-1" });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select({ flag: user.mustChangePassword }).from(user).where(eq(user.id, u.id));
    expect(row.flag).toBe(false);
    expect(res.json<{ user: { id: string } }>().user.id).toBe(u.id);
  });
});

afterAll(async () => {
  if (!userIds.length) return;
  await db.delete(session).where(inArray(session.userId, userIds));
  await db.delete(account).where(inArray(account.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
});
