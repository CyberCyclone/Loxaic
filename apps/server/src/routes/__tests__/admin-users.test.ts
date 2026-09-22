import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";

/**
 * `/v1/admin/users` through a real Fastify instance; only authentication is
 * stubbed, as in admin-providers.test.ts. Held here: `requireAdmin` is the
 * boundary on both verbs, the listing never carries anything derived from a
 * password (checked on the raw bytes), and a reset really does flag the
 * account and sign it out.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  requireAdmin: (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!currentUser.id.startsWith("admin")) {
      reply.code(403).send({ error: "Admin access required" });
      throw new Error("Forbidden");
    }
    return Promise.resolve(currentUser.id);
  },
}));

const { adminUserRoutes } = await import("../admin-users.ts");

const adminId = `admin-users-${uuid()}`;
const plainId = `plain-users-${uuid()}`;
const expiredBanId = `plain-users-expired-${uuid()}`;
const activeBanId = `plain-users-banned-${uuid()}`;
const ids = [adminId, plainId, expiredBanId, activeBanId];
const app = Fastify();
adminUserRoutes(app);

interface UserRow { id: string; email: string; mustChangePassword: boolean; role: string | null; banned: boolean }

beforeAll(async () => {
  await app.ready();
  for (const id of ids) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }
  await db.update(user).set({ banned: true, banExpires: new Date(Date.now() - 60_000) }).where(eq(user.id, expiredBanId));
  await db.update(user).set({ banned: true, banExpires: new Date(Date.now() + 60_000) }).where(eq(user.id, activeBanId));
  await db.insert(account).values({
    id: uuid(), accountId: plainId, providerId: "credential", userId: plainId,
    password: "scrypt-hash-that-must-never-appear", createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(session).values({
    id: uuid(), token: `tok-${uuid()}`, userId: plainId,
    expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(session).where(inArray(session.userId, ids));
  await db.delete(account).where(inArray(account.userId, ids));
  await db.delete(user).where(inArray(user.id, ids));
});

describe("/v1/admin/users", () => {
  it("is admin-only on both verbs", async () => {
    currentUser.id = plainId;
    expect((await app.inject({ method: "GET", url: "/v1/admin/users" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/admin/users/${adminId}/reset-password` })).statusCode).toBe(403);
  });

  it("lists users without anything password-shaped", async () => {
    currentUser.id = adminId;
    const res = await app.inject({ method: "GET", url: `/v1/admin/users?q=${plainId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("scrypt-hash-that-must-never-appear");
    expect(res.body).not.toMatch(/"password"/);
    const row = res.json<{ users: UserRow[] }>().users.find((u) => u.id === plainId);
    expect(row).toMatchObject({ email: `${plainId}@example.test`, mustChangePassword: false, banned: false });
  });

  it("searches by any part of the email or name, and says how many matched", async () => {
    currentUser.id = adminId;
    // The tail of the uuid, upper-cased: a case-insensitive substring that
    // only this file's plain user can match.
    const res = await app.inject({ method: "GET", url: `/v1/admin/users?q=${plainId.slice(-12).toUpperCase()}` });
    const body = res.json<{ users: UserRow[]; total: number }>();
    expect(body.users.map((u) => u.id)).toEqual([plainId]);
    expect(body.total).toBe(1);
    // A bare wildcard is a literal, not "everyone".
    const wild = await app.inject({ method: "GET", url: "/v1/admin/users?q=%25%25%25" });
    expect(wild.json<{ total: number }>().total).toBe(0);
    // Unfiltered, the total counts past the page.
    const all = await app.inject({ method: "GET", url: "/v1/admin/users" });
    expect(all.json<{ total: number }>().total).toBeGreaterThanOrEqual(2);
  });

  it("reports a ban only while the middleware would enforce it", async () => {
    currentUser.id = adminId;
    const res = await app.inject({ method: "GET", url: "/v1/admin/users?q=plain-users-" });
    const users = res.json<{ users: UserRow[] }>().users;
    expect(users.find((u) => u.id === expiredBanId)?.banned).toBe(false);
    expect(users.find((u) => u.id === activeBanId)?.banned).toBe(true);
    expect(res.body).not.toContain("banExpires");
  });

  it("resets a password: returns it once, flags the user, ends their sessions", async () => {
    currentUser.id = adminId;
    const res = await app.inject({ method: "POST", url: `/v1/admin/users/${plainId}/reset-password` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ temporaryPassword: string }>().temporaryPassword).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
    expect(await db.select().from(session).where(eq(session.userId, plainId))).toHaveLength(0);
    const list = await app.inject({ method: "GET", url: `/v1/admin/users?q=${plainId}` });
    expect(list.json<{ users: UserRow[] }>().users.find((u) => u.id === plainId)?.mustChangePassword).toBe(true);
  });

  it("404s for an id that is not a user", async () => {
    currentUser.id = adminId;
    const res = await app.inject({ method: "POST", url: `/v1/admin/users/nobody-${uuid()}/reset-password` });
    expect(res.statusCode).toBe(404);
  });
});
