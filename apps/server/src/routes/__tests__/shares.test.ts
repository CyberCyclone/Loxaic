import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, user } from "@loxaic/db/schema";

/**
 * Route-level tests — the harness #59 asked for, started here because #76 is
 * where twelve inlined ownership checks became one role helper, and a
 * refactor of that shape is exactly what "the RCE lived in an untested route"
 * was about.
 *
 * Requests go through a real Fastify instance via `inject`, so routing, the
 * status codes, and the JSON body are all exercised rather than the handler
 * being called as a bare function. Only authentication is stubbed: the point
 * is to test what a *given* user is allowed to do, and standing up
 * better-auth sessions per case would test better-auth instead.
 */
interface ShareRow {
  userId: string;
  role: string;
  createdBy: string;
  name: string;
  email: string;
}

/** `inject`'s json() is `any`; read it through a shape instead so the tests
 * type-check as strictly as the code they exercise. */
function sharesOf(res: { json: () => unknown }): ShareRow[] {
  return (res.json() as { shares: ShareRow[] }).shares;
}

function usersOf(res: { json: () => unknown }): { id: string }[] {
  return (res.json() as { users: { id: string }[] }).users;
}

function adminRowsOf(res: { json: () => unknown }): { id: string; shareCount: number }[] {
  return res.json() as { id: string; shareCount: number }[];
}

const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!currentUser.id.startsWith("admin")) {
      reply.code(403).send({ error: "Admin access required" });
      throw new Error("Forbidden");
    }
    return Promise.resolve(currentUser.id);
  },
}));

const { adminConversationRoutes, shareRoutes } = await import("../shares.ts");

const owner = `test-shares-owner-${uuid()}`;
const guest = `test-shares-guest-${uuid()}`;
const stranger = `test-shares-stranger-${uuid()}`;
const admin = `admin-test-shares-${uuid()}`;
const everyone = [owner, guest, stranger, admin];

let convId: string;
const app = Fastify();

function as(userId: string) {
  currentUser.id = userId;
}

beforeAll(async () => {
  shareRoutes(app);
  adminConversationRoutes(app);
  await app.ready();

  await db.insert(user).values(
    everyone.map((id) => ({
      id,
      name: id.startsWith("admin") ? "Admin" : "Person",
      email: `${id}@example.test`,
      emailVerified: true,
      ...(id.startsWith("admin") ? { role: "admin" } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  const [conv] = await db
    .insert(conversations)
    .values({ ownerId: owner, title: "shares route test" })
    .returning();
  convId = conv.id;
});

afterEach(async () => {
  await db.delete(conversationShares).where(eq(conversationShares.conversationId, convId));
});

afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(user).where(inArray(user.id, everyone));
  await app.close();
});

describe("PUT /v1/conversations/:id/shares", () => {
  it("lets the owner grant access", async () => {
    as(owner);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "editor" },
    });
    expect(res.statusCode).toBe(200);
    expect(sharesOf(res)).toHaveLength(1);
    expect(sharesOf(res)[0]).toMatchObject({ userId: guest, role: "editor" });
  });

  it("404s for a non-owner — the same answer as a conversation that isn't there", async () => {
    as(stranger);
    const real = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: stranger, role: "editor" },
    });
    const fake = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${uuid()}/shares`,
      payload: { user_id: stranger, role: "editor" },
    });
    expect(real.statusCode).toBe(404);
    expect(real.body).toBe(fake.body);
  });

  it("does not let a shared editor re-share — sharing is the owner's alone", async () => {
    as(owner);
    await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "editor" },
    });
    as(guest);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: stranger, role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("updates rather than duplicating when re-shared at a different role", async () => {
    as(owner);
    await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "viewer" },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "editor" },
    });
    expect(sharesOf(res)).toHaveLength(1);
    expect(sharesOf(res)[0].role).toBe("editor");
  });

  it("rejects an unknown role by falling back to viewer, never by trusting it", async () => {
    as(owner);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "owner" },
    });
    // "owner" is not a grantable role: ownership lives on the conversation,
    // not in this table, so it must degrade rather than escalate.
    expect(sharesOf(res)[0].role).toBe("viewer");
  });

  it("refuses to share a conversation with its own owner", async () => {
    as(owner);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: owner, role: "editor" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /v1/conversations/:id/shares/:userId", () => {
  it("revokes, and 404s for a non-owner attempting it", async () => {
    as(owner);
    await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "editor" },
    });

    as(stranger);
    const refused = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${convId}/shares/${guest}`,
    });
    expect(refused.statusCode).toBe(404);

    as(owner);
    const ok = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${convId}/shares/${guest}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(sharesOf(ok)).toHaveLength(0);
  });
});

describe("GET /v1/users/search", () => {
  it("returns nothing for a query too short to be a real lookup", async () => {
    as(owner);
    const res = await app.inject({ method: "GET", url: "/v1/users/search?q=a" });
    expect(usersOf(res)).toEqual([]);
  });

  it("never returns the caller themselves", async () => {
    as(owner);
    const res = await app.inject({
      method: "GET",
      url: `/v1/users/search?q=${encodeURIComponent("test-shares-")}`,
    });
    const ids = usersOf(res).map((u) => u.id);
    expect(ids).not.toContain(owner);
  });

  it("treats % and _ as literal characters, not wildcards", async () => {
    // `%@` is two characters, so it clears the length guard — and unescaped
    // it becomes the pattern `%@%`, which matches every email on the
    // deployment and turns this back into the directory the route says it
    // isn't. Nobody in the fixture has a literal `%@` in their name or email,
    // so an escaped prefix match must return nothing.
    as(owner);
    const res = await app.inject({ method: "GET", url: `/v1/users/search?q=${encodeURIComponent("%@")}` });
    expect(usersOf(res)).toEqual([]);
    const underscore = await app.inject({ method: "GET", url: `/v1/users/search?q=${encodeURIComponent("__")}` });
    expect(usersOf(underscore)).toEqual([]);
  });

  it("does not stringify an array query into a search term", async () => {
    // `?q[]=a&q[]=b` arrives as an array; String()-ing it would search for
    // "[object Object]" and quietly return whatever matched.
    as(owner);
    const res = await app.inject({ method: "GET", url: "/v1/users/search?q[]=aa&q[]=bb" });
    expect(usersOf(res)).toEqual([]);
  });
});

describe("admin conversation routes", () => {
  it("refuses a non-admin", async () => {
    as(owner);
    const res = await app.inject({ method: "GET", url: "/v1/admin/conversations" });
    expect(res.statusCode).toBe(403);
  });

  it("lists conversations with a share count for an admin", async () => {
    as(owner);
    await app.inject({
      method: "PUT",
      url: `/v1/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "viewer" },
    });

    as(admin);
    const res = await app.inject({ method: "GET", url: "/v1/admin/conversations" });
    expect(res.statusCode).toBe(200);
    const row = adminRowsOf(res).find((r) => r.id === convId);
    expect(row?.shareCount).toBe(1);
  });

  it("lets an admin grant and revoke, but not make someone the owner", async () => {
    as(admin);
    const granted = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/shares`,
      payload: { user_id: stranger, role: "editor" },
    });
    expect(sharesOf(granted)[0]).toMatchObject({ userId: stranger, role: "editor" });

    const ownerAttempt = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/shares`,
      payload: { user_id: owner, role: "editor" },
    });
    expect(ownerAttempt.statusCode).toBe(400);

    const revoked = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/shares`,
      payload: { user_id: stranger, revoke: true },
    });
    expect(sharesOf(revoked)).toHaveLength(0);
  });

  it("404s an admin grant to a user that does not exist, rather than 500ing on the FK", async () => {
    as(admin);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/shares`,
      payload: { user_id: `nobody-${uuid()}`, role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("records the admin as the grantor, so the row says who did it", async () => {
    as(admin);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/shares`,
      payload: { user_id: guest, role: "viewer" },
    });
    expect(sharesOf(res)[0].createdBy).toBe(admin);
  });
});
