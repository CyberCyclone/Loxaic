import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";

process.env.MCP_ENCRYPTION_KEY ??= "admin-providers-test-key";

import { db, eq } from "@loxaic/db";
import { inferenceProviders, user } from "@loxaic/db/schema";

/**
 * `/v1/admin/providers` through a real Fastify instance, matching
 * shares.test.ts — only authentication is stubbed.
 *
 * Two things are being held here. First, that hiding the screen from a
 * non-admin is presentation and `requireAdmin` is the boundary: a non-admin
 * gets 403 from every verb, including the read. Second, that no response ever
 * carries the API key — asserted on the raw response *bytes* rather than on a
 * parsed field, because the way a key escapes is through some field nobody
 * thought to check.
 */
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

const { adminProviderRoutes } = await import("../admin-providers.ts");

const adminId = `admin-providers-${uuid()}`;
const plainId = `plain-providers-${uuid()}`;
const API_KEY = "sk-super-secret-value-0123456789";

const app = Fastify();
adminProviderRoutes(app);

interface ProviderBody {
  id: string;
  name: string;
  slug: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  modelAllowlist: string[] | null;
}

beforeAll(async () => {
  await app.ready();
  for (const id of [adminId, plainId]) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  currentUser.id = adminId;
});

afterAll(async () => {
  // Scoped to this file's own rows: provider rows are deployment-wide and
  // vitest shares one database, so an unscoped delete would take another
  // suite's rows out from under it.
  await db.delete(inferenceProviders).where(eq(inferenceProviders.createdBy, adminId));
  await db.delete(user).where(eq(user.id, adminId));
  await db.delete(user).where(eq(user.id, plainId));
  await app.close();
});

async function create(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/providers",
    payload: {
      name: `Test ${uuid().slice(0, 8)}`,
      // Nothing listens here, so a probe fails instantly with ECONNREFUSED
      // rather than spending a timeout — never a blackhole address.
      baseUrl: "http://127.0.0.1:1/v1",
      ...payload,
    },
  });
}

describe("admin gating", () => {
  it("refuses every verb for a non-admin", async () => {
    currentUser.id = plainId;
    try {
      const made = await app.inject({ method: "GET", url: "/v1/admin/providers" });
      expect(made.statusCode).toBe(403);
      expect((await create()).statusCode).toBe(403);
      expect(
        (await app.inject({ method: "PATCH", url: "/v1/admin/providers/x", payload: { name: "n" } })).statusCode,
      ).toBe(403);
      expect((await app.inject({ method: "DELETE", url: "/v1/admin/providers/x" })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/v1/admin/providers/x/test" })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/v1/admin/providers/x/models" })).statusCode).toBe(403);
    } finally {
      currentUser.id = adminId;
    }
  });
});

describe("the API key", () => {
  it("never appears in any response", async () => {
    const created = await create({ apiKey: API_KEY });
    expect(created.statusCode).toBe(201);
    const id = created.json<ProviderBody>().id;

    const list = await app.inject({ method: "GET", url: "/v1/admin/providers" });
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/admin/providers/${id}`,
      payload: { name: "Renamed" },
    });
    // The test endpoint fails against a closed port, which is the path most
    // likely to echo a credential back in an error.
    const tested = await app.inject({ method: "POST", url: `/v1/admin/providers/${id}/test` });

    for (const res of [created, list, patched, tested]) {
      expect(res.body).not.toContain(API_KEY);
      // Not the stored ciphertext either — it decrypts with a key an operator
      // may have in the same place.
      expect(res.body).not.toContain("v1:");
    }
    expect(created.json<ProviderBody>().hasApiKey).toBe(true);
  });

  it("is kept when an edit does not mention it", async () => {
    const id = (await create({ apiKey: API_KEY })).json<ProviderBody>().id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/admin/providers/${id}`,
      payload: { name: "Only a rename" },
    });
    expect(patched.json<ProviderBody>().hasApiKey).toBe(true);
  });

  it("is cleared by an explicit null", async () => {
    const id = (await create({ apiKey: API_KEY })).json<ProviderBody>().id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/admin/providers/${id}`,
      payload: { apiKey: null },
    });
    expect(patched.json<ProviderBody>().hasApiKey).toBe(false);
  });
});

describe("validation", () => {
  it("refuses a bad base URL with 400, not a 500", async () => {
    const res = await create({ baseUrl: "not-a-url" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/valid URL/i);
  });

  it("refuses an Authorization header", async () => {
    const res = await create({ headers: { Authorization: "Bearer sneaky" } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a slug change, naming why", async () => {
    const id = (await create({})).json<ProviderBody>().id;
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/providers/${id}`,
      payload: { slug: "different" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/cannot be changed/i);
  });

  it("404s for an id that is not there", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/providers/${uuid()}`,
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the list", () => {
  it("describes the built-in backend without making it editable", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/v1/admin/providers" })
    ).json<{ builtin: { id: string; runtimeState: string; models: number }; providers: ProviderBody[] }>();
    expect(body.builtin.id).toBe("default");
    // The built-in provider is the local runtime, managed on its own screen:
    // described here with enough to link across, and nothing to edit.
    expect(typeof body.builtin.runtimeState).toBe("string");
    expect(typeof body.builtin.models).toBe("number");
    expect(body.builtin).not.toHaveProperty("baseUrl");
  });

  it("includes a provider this file created", async () => {
    // "Contains", never an exact set: other suites share this database.
    const id = (await create({})).json<ProviderBody>().id;
    const body = (
      await app.inject({ method: "GET", url: "/v1/admin/providers" })
    ).json<{ providers: ProviderBody[] }>();
    expect(body.providers.map((p) => p.id)).toContain(id);
  });
});

describe("testing a provider", () => {
  it("answers 200 with the reason rather than failing the request", async () => {
    // The question "can you reach it?" is answered either way; a 5xx here
    // would be the server reporting the provider's unreachability as its own
    // fault.
    const id = (await create({})).json<ProviderBody>().id;
    const res = await app.inject({ method: "POST", url: `/v1/admin/providers/${id}/test` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; error?: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("records the failure on the row for the list to show", async () => {
    const id = (await create({})).json<ProviderBody>().id;
    await app.inject({ method: "POST", url: `/v1/admin/providers/${id}/test` });
    const row = await db.query.inferenceProviders.findFirst({ where: eq(inferenceProviders.id, id) });
    expect(row?.lastError).toBeTruthy();
    expect(row?.lastCheckedAt).toBeTruthy();
    expect(row?.lastError).not.toContain(API_KEY);
  });
});
