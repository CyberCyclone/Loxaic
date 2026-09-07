import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { githubConnections, user } from "@loxaic/db/schema";

// Same convention as mcp/__tests__/registry.test.ts: the encryption module
// throws without a key, and this repo's real BETTER_AUTH_SECRET is only
// loaded when something reads .env, which a plain vitest run does not do.
process.env.MCP_ENCRYPTION_KEY ??= "github-test-key";

/**
 * `/v1/github/*` through a real Fastify instance and a real HTTP server
 * standing in for the GitHub API — same shape as prefs.test.ts (auth stubbed,
 * everything else real). `GITHUB_API_URL` is the seam apps/server/src/github
 * /client.ts reads at call time specifically so tests never touch the real
 * GitHub API.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { githubRoutes } = await import("../github.ts");

const userId = `test-github-${uuid()}`;
const app = Fastify();
githubRoutes(app);

/** A deliberately minimal fake: enough of `/user`, `/user/repos`, and
 * `/repos/:owner/:repo/branches` to drive every route, plus a knob
 * (`nextToken`) to swap between an accepted and a rejected token without
 * restarting the server. */
let nextAccepted = "good-token";
let mockServer: Server;
let mockPort: number;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => { resolve(data); });
  });
}

beforeAll(async () => {
  mockServer = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer /, "");
      const url = req.url ?? "";

      if (token !== nextAccepted) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }

      if (url === "/user") {
        res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": "repo" });
        res.end(JSON.stringify({ login: "octocat", name: "The Octocat", email: "octocat@example.test" }));
        return;
      }
      if (url.startsWith("/user/repos")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { id: 1, full_name: "octocat/hello-world", private: false, default_branch: "main", clone_url: "https://example.test/hello-world.git" },
            { id: 2, full_name: "octocat/other", private: true, default_branch: "trunk", clone_url: "https://example.test/other.git" },
          ]),
        );
        return;
      }
      if (url === "/repos/octocat/hello-world") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 1, full_name: "octocat/hello-world", private: false, default_branch: "main", clone_url: "x" }));
        return;
      }
      if (url.startsWith("/repos/octocat/hello-world/branches")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ name: "main" }, { name: "dev" }]));
        return;
      }
      void (await readBody(req));
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found in fixture" }));
    })();
  });
  await new Promise<void>((resolve) => { mockServer.listen(0, "127.0.0.1", resolve); });
  mockPort = (mockServer.address() as { port: number }).port;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String(mockPort)}`;

  await app.ready();
  await db.insert(user).values({
    id: userId,
    name: "Test Github",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  currentUser.id = userId;
});

afterEach(async () => {
  nextAccepted = "good-token";
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
  await new Promise((resolve) => { mockServer.close(resolve); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
});

interface ConnectionBody {
  login: string;
  name: string | null;
  email: string | null;
  scopes: string | null;
  validatedAt: string;
}

describe("PUT /v1/github/connection", () => {
  it("validates the token, stores it encrypted, and never echoes it back", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/github/connection",
      payload: { token: "good-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ConnectionBody>();
    const { validatedAt, ...rest } = body;
    expect(rest).toEqual({ login: "octocat", name: "The Octocat", email: "octocat@example.test", scopes: "repo" });
    expect(typeof validatedAt).toBe("string");

    const row = await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) });
    expect(row).toBeTruthy();
    // The stored blob must not contain the plaintext token anywhere in it —
    // this is the one guarantee the whole feature rests on.
    expect(row?.encryptedToken).not.toContain("good-token");
    expect(JSON.stringify(body)).not.toContain("good-token");
  });

  it("rejects an empty token before ever calling GitHub", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "" } });
    expect(res.statusCode).toBe(400);
    const row = await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) });
    expect(row).toBeUndefined();
  });

  it("rejects a bad token with a redacted 400, and stores nothing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/github/connection",
      payload: { token: "wrong-token" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).not.toContain("wrong-token");

    const row = await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) });
    expect(row).toBeUndefined();
  });

  it("replaces an existing connection rather than duplicating the row", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const rows = await db.query.githubConnections.findMany({ where: eq(githubConnections.userId, userId) });
    expect(rows).toHaveLength(1);
  });
});

describe("GET /v1/github/connection", () => {
  it("returns null when nothing is connected", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/github/connection" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("never returns the token, even in the shape of the response", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const res = await app.inject({ method: "GET", url: "/v1/github/connection" });
    expect(Object.keys(res.json<ConnectionBody>()).sort()).toEqual(
      ["email", "login", "name", "scopes", "validatedAt"].sort(),
    );
  });
});

describe("DELETE /v1/github/connection", () => {
  it("removes the row", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const del = await app.inject({ method: "DELETE", url: "/v1/github/connection" });
    expect(del.statusCode).toBe(200);
    const row = await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) });
    expect(row).toBeUndefined();
  });

  it("is idempotent when nothing is connected", async () => {
    const res = await app.inject({ method: "DELETE", url: "/v1/github/connection" });
    expect(res.statusCode).toBe(200);
  });
});

interface RepoBody {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

describe("GET /v1/github/repos", () => {
  it("404s when GitHub is not connected", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/github/repos" });
    expect(res.statusCode).toBe(404);
  });

  it("lists the connected user's repos", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const res = await app.inject({ method: "GET", url: "/v1/github/repos" });
    expect(res.statusCode).toBe(200);
    expect(res.json<RepoBody[]>()).toEqual([
      { id: 1, full_name: "octocat/hello-world", private: false, default_branch: "main" },
      { id: 2, full_name: "octocat/other", private: true, default_branch: "trunk" },
    ]);
  });

  it("filters by q", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const res = await app.inject({ method: "GET", url: "/v1/github/repos?q=other" });
    expect(res.json<RepoBody[]>().map((r) => r.full_name)).toEqual(["octocat/other"]);
  });
});

describe("GET /v1/github/repos/:owner/:repo/branches", () => {
  it("returns the default branch and the branch list", async () => {
    await app.inject({ method: "PUT", url: "/v1/github/connection", payload: { token: "good-token" } });
    const res = await app.inject({ method: "GET", url: "/v1/github/repos/octocat/hello-world/branches" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ default_branch: string; branches: string[] }>()).toEqual({
      default_branch: "main",
      branches: ["main", "dev"],
    });
  });
});
