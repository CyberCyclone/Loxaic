import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversationShares, conversations, githubConnections, sandboxes, user } from "@loxaic/db/schema";
import { upsertConnection } from "../../github/connection.ts";

process.env.MCP_ENCRYPTION_KEY ??= "git-route-test-key";

/**
 * `/v1/conversations/:id/git/*` through a real Fastify instance, a real host
 * sandbox (`SANDBOX_MODE=host`, no Docker needed), and a real `file://`
 * origin — only GitHub's `POST .../pulls` is faked, since that is the one
 * call that has to leave the machine. Same shape as prefs.test.ts: only
 * `authenticate` is stubbed.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { gitRoutes } = await import("../git.ts");
const { getConversationSandbox } = await import("../../agent/sandbox-manager.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");

const app = Fastify();
gitRoutes(app);

const ownerId = `test-git-owner-${uuid()}`;
const editorId = `test-git-editor-${uuid()}`;
let root: string;
let mockGithub: Server;
let pullsCalls = 0;

beforeAll(async () => {
  await app.ready();

  mockGithub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/repos/octo/real/pulls") {
      pullsCalls++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ number: 7, html_url: "https://github.example/octo/real/pull/7" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found in fixture" }));
  });
  await new Promise<void>((r) => { mockGithub.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((mockGithub.address() as { port: number }).port)}`;

  await db.insert(user).values([
    { id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: editorId, name: "Editor", email: `${editorId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await upsertConnection(ownerId, { token: "tok", login: "octo", name: "Octo Cat", email: null, scopes: "repo" });
});

afterAll(async () => {
  await db.delete(githubConnections).where(eq(githubConnections.userId, ownerId));
  await db.delete(user).where(eq(user.id, ownerId));
  await db.delete(user).where(eq(user.id, editorId));
  await new Promise((r) => { mockGithub.close(r); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
  await app.close();
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-git-route-"));
  process.env.SANDBOX_HOST_ROOT = path.join(root, "sandboxes");
  process.env.SANDBOX_MODE = "host";
  currentUser.id = ownerId;
  pullsCalls = 0;
});

afterEach(async () => {
  Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
  Reflect.deleteProperty(process.env, "SANDBOX_MODE");
  rmSync(root, { recursive: true, force: true });
  // Scoped to this file's own owner — an unscoped delete would wipe rows
  // that other test files' concurrently-running sandboxes just inserted
  // (confirmed: it made src/agent/__tests__/lifecycle.test.ts flake when
  // the two files ran in the same vitest run). conversationShares needs no
  // delete of its own: it cascades from conversations.
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
});

/** A fresh bare `file://` origin with one commit on `main`, so each test's
 * pushes land in its own remote rather than a previous test's. */
function freshOrigin(): string {
  const work = path.join(root, `work-${uuid()}`);
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@e", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@e" };
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(path.join(work, "README.md"), "hello\n");
  execFileSync("git", ["-C", work, "add", "."], { env });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "init"], { env });
  const bare = path.join(root, `origin-${uuid()}.git`);
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { env });
  return bare;
}

async function newConversation(workspace: unknown): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ ownerId, title: "git route test", kind: "agent", workspace })
    .returning();
  return row.id;
}

async function githubConversation(): Promise<{ id: string; branch: string }> {
  const branch = `loxaic/${Math.random().toString(16).slice(2, 8)}`;
  const origin = freshOrigin();
  const id = await newConversation({
    kind: "github", repo: "octo/real", baseBranch: "main", branch, cloneUrl: `file://${origin}`,
  });
  return { id, branch };
}

/** Simulates the agent having already worked in the repo: clones it for
 * real through the same path the tool loop uses. */
async function cloneFor(conversationId: string): Promise<void> {
  await getConversationSandbox(ownerId, conversationId);
}

interface StatusBody {
  cloned: boolean;
  repo: string;
  branch: string;
  baseBranch: string;
  pr: { number: number; url: string } | null;
  changed?: { path: string; status: string }[];
  ahead?: number;
  behind?: number;
}

describe("GET /v1/conversations/:id/git/status", () => {
  it("404s for a conversation that doesn't exist", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${uuid()}/git/status` });
    expect(res.statusCode).toBe(404);
  });

  it("400s on a scratch workspace", async () => {
    const id = await newConversation(null);
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
    expect(res.statusCode).toBe(400);
  });

  it("says nothing is cloned yet, without creating a sandbox", async () => {
    const { id, branch } = await githubConversation();
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatusBody>();
    expect(body).toEqual({ cloned: false, repo: "octo/real", branch, baseBranch: "main", pr: null });

    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, id) });
    expect(rows).toHaveLength(0);
  });

  it("reports a clean tree with nothing ahead once cloned", async () => {
    const { id } = await githubConversation();
    await cloneFor(id);
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
    const body = res.json<StatusBody>();
    expect(body.cloned).toBe(true);
    expect(body.changed).toEqual([]);
    expect(body.ahead).toBe(0);
    expect(body.behind).toBe(0);
  });

  it("lists an untracked file and counts commits ahead after a commit", async () => {
    const { id } = await githubConversation();
    const handle = await getConversationSandbox(ownerId, id);
    await handle.writeFile(path.join(handle.workdir, "notes.txt"), "hi\n");

    const dirty = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
    expect(dirty.json<StatusBody>().changed).toEqual([{ path: "notes.txt", status: "untracked" }]);

    await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "add notes" } });
    const afterCommit = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
    const body = afterCommit.json<StatusBody>();
    expect(body.changed).toEqual([]);
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(0);
  });

  it("is owner-only — an editor gets the same 404 as a stranger", async () => {
    const { id } = await githubConversation();
    await db.insert(conversationShares).values({ conversationId: id, userId: editorId, role: "editor", createdBy: ownerId });
    currentUser.id = editorId;
    try {
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${id}/git/status` });
      expect(res.statusCode).toBe(404);
    } finally {
      currentUser.id = ownerId;
    }
  });
});

describe("POST /v1/conversations/:id/git/commit", () => {
  it("400s before anything has been cloned, rather than cloning to commit nothing", async () => {
    const { id } = await githubConversation();
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "x" } });
    expect(res.statusCode).toBe(400);
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, id) });
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty message", async () => {
    const { id } = await githubConversation();
    await cloneFor(id);
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "  " } });
    expect(res.statusCode).toBe(400);
  });

  it("says there is nothing to commit on a clean tree", async () => {
    const { id } = await githubConversation();
    await cloneFor(id);
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/nothing to commit/i);
  });

  it("commits with the connection's identity, even though the clone already set it", async () => {
    const { id } = await githubConversation();
    const handle = await getConversationSandbox(ownerId, id);
    await handle.writeFile(path.join(handle.workdir, "a.txt"), "a\n");
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "add a" } });
    expect(res.statusCode).toBe(200);
    const log = await handle.exec(["git", "log", "-1", "--format=%an <%ae>"], { workdir: handle.workdir });
    expect(log.stdout.trim()).toBe("Octo Cat <octo@users.noreply.github.com>");
  });

  it("409s while a run is active", async () => {
    const { id } = await githubConversation();
    await cloneFor(id);
    registerRun({ streamId: "s-commit", conversationId: id, userId: ownerId, abort: new AbortController(), approvals: new Map() });
    try {
      const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "x" } });
      expect(res.statusCode).toBe(409);
    } finally {
      unregisterRun("s-commit");
    }
  });
});

describe("POST /v1/conversations/:id/git/push", () => {
  it("pushes the branch to origin", async () => {
    const { id, branch } = await githubConversation();
    const handle = await getConversationSandbox(ownerId, id);
    await handle.writeFile(path.join(handle.workdir, "a.txt"), "a\n");
    await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/commit`, payload: { message: "add a" } });

    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/push` });
    expect(res.statusCode).toBe(200);

    // Read straight from the bare repo — the origin's own view, not the
    // sandbox's, is what proves the push landed.
    const remote = await handle.exec(["git", "config", "--get", "remote.origin.url"], { workdir: handle.workdir });
    const originPath = remote.stdout.trim().replace("file://", "");
    const branches = execFileSync("git", ["--git-dir", originPath, "branch", "--list", branch]).toString();
    expect(branches).toContain(branch);
  });

  it("400s before anything has been cloned", async () => {
    const { id } = await githubConversation();
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/push` });
    expect(res.statusCode).toBe(400);
  });

  it("409s while a run is active", async () => {
    const { id } = await githubConversation();
    await cloneFor(id);
    registerRun({ streamId: "s-push", conversationId: id, userId: ownerId, abort: new AbortController(), approvals: new Map() });
    try {
      const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/push` });
      expect(res.statusCode).toBe(409);
    } finally {
      unregisterRun("s-push");
    }
  });
});

describe("POST /v1/conversations/:id/git/pr", () => {
  it("opens a pull request and persists it on the workspace", async () => {
    const { id } = await githubConversation();
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/pr`, payload: { title: "My change" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ number: 7, url: "https://github.example/octo/real/pull/7" });
    expect(pullsCalls).toBe(1);

    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
    expect((row?.workspace as { pr?: unknown } | undefined)?.pr).toEqual({ number: 7, url: "https://github.example/octo/real/pull/7" });
  });

  it("is idempotent — a second call returns the stored PR without asking GitHub again", async () => {
    const { id } = await githubConversation();
    await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/pr`, payload: { title: "My change" } });
    const second = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/pr`, payload: { title: "different title" } });
    expect(second.json()).toEqual({ number: 7, url: "https://github.example/octo/real/pull/7" });
    expect(pullsCalls).toBe(1);
  });

  it("rejects an empty title", async () => {
    const { id } = await githubConversation();
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/pr`, payload: { title: "" } });
    expect(res.statusCode).toBe(400);
    expect(pullsCalls).toBe(0);
  });

  it("409s while a run is active", async () => {
    const { id } = await githubConversation();
    registerRun({ streamId: "s-pr", conversationId: id, userId: ownerId, abort: new AbortController(), approvals: new Map() });
    try {
      const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/git/pr`, payload: { title: "x" } });
      expect(res.statusCode).toBe(409);
    } finally {
      unregisterRun("s-pr");
    }
    expect(pullsCalls).toBe(0);
  });
});
