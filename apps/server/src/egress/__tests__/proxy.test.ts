import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { ProxyAgent, request } from "undici";
import { db, eq } from "@loxaic/db";
import { conversations, githubConnections, user } from "@loxaic/db/schema";
import { upsertConnection } from "../../github/connection.ts";
import { startGitHttpServer, type GitHttpServer } from "./git-http-server.ts";
import { __resetEgressCaForTest, egressCa } from "../ca.ts";
import { signEgressCredential } from "../credential.ts";
import { forgetEgressToken, startEgressProxy, type EgressProxy } from "../proxy.ts";

process.env.MCP_ENCRYPTION_KEY ??= "egress-proxy-test-key";
const run = promisify(execFile);

/**
 * The egress proxy end to end, with the clients a sandbox really runs: `git`
 * clones and pushes through it against a smart-HTTP git server standing in
 * for github.com, and API requests go through it to a mock api.github.com.
 * What is asserted is what each upstream saw — the owner's token, added by the
 * proxy — and what a refused write looks like to the client.
 */
const TOKEN = "ghp_egress_test_token_123";
const BRANCH = "loxaic/feature";
const ownerId = `test-egress-${uuid()}`;
let dir = "";
let git: GitHttpServer;
let api: http.Server;
let apiSeen: { method: string; url: string; auth?: string; body: string }[] = [];
let proxy: EgressProxy;
let githubConv = "";
let scratchConv = "";

const gitEnv = (credential: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: path.join(dir, "home"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  HTTPS_PROXY: `http://sbx:${credential}@127.0.0.1:${String(proxy.port)}`,
  GIT_SSL_CAINFO: path.join(dir, "ca.pem"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
});

async function gitIn(cwd: string, credential: string, ...args: string[]) {
  return run("git", args, { cwd, env: gitEnv(credential) }).then(
    (r) => ({ ok: true, stdout: r.stdout, stderr: r.stderr }),
    (err: unknown) => {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    },
  );
}

function bareHead(ref: string): string | null {
  try {
    return readFileSync(path.join(dir, "repos", "e2e", "demo.git", "refs", "heads", ...ref.split("/")), "utf8").trim();
  } catch {
    return null;
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-egress-"));
  process.env.EGRESS_CA_DIR = path.join(dir, "ca");
  __resetEgressCaForTest();
  writeFileSync(path.join(dir, "ca.pem"), egressCa().certPem);

  // A bare repository with one commit on main.
  const work = path.join(dir, "work");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  await run("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(path.join(work, "README.md"), "hello\n");
  await run("git", ["-C", work, "add", "."], { env });
  await run("git", ["-C", work, "commit", "-q", "-m", "init"], { env });
  await run("git", ["clone", "-q", "--bare", work, path.join(dir, "repos", "e2e", "demo.git")], { env });

  git = await startGitHttpServer({ root: path.join(dir, "repos"), token: TOKEN });
  api = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      apiSeen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const json = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/repos/e2e/demo") { json({ full_name: "e2e/demo", node_id: "R_demo" }); return; }
      const pull = /^\/repos\/e2e\/demo\/pulls\/(\d+)$/.exec(req.url ?? "");
      if (pull) {
        const ref = pull[1] === "1" ? BRANCH : "someone-else";
        json({ base: { repo: { full_name: "e2e/demo" } }, head: { ref, repo: { full_name: "e2e/demo" } } }); return;
      }
      if (req.url === "/graphql") {
        const parsed = JSON.parse(body) as { query: string; variables?: { id?: string } };
        if (parsed.query.includes("node(id:")) {
          const id = parsed.variables?.id;
          const node =
            id === "PR_1"
              ? { __typename: "PullRequest", headRefName: BRANCH, repository: { nameWithOwner: "e2e/demo" }, headRepository: { nameWithOwner: "e2e/demo" } }
              : id === "I_1"
                ? { __typename: "Issue", repository: { nameWithOwner: "e2e/demo" } }
                : { __typename: "PullRequest", headRefName: "main", repository: { nameWithOwner: "e2e/demo" }, headRepository: { nameWithOwner: "e2e/demo" } };
          json({ data: { node } }); return;
        }
        json({ data: { ok: true } }); return;
      }
      json({});
    });
  });
  await new Promise<void>((r) => { api.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_WEB_URL = git.url;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;

  await db.insert(user).values({ id: ownerId, name: "Egress", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await upsertConnection(ownerId, { token: TOKEN, login: "octo", name: "Octo", email: null, scopes: "repo" });
  const [gh] = await db
    .insert(conversations)
    .values({
      ownerId,
      title: "egress",
      kind: "agent",
      workspace: { kind: "github", repo: "e2e/demo", baseBranch: "main", branch: BRANCH, cloneUrl: "https://github.com/e2e/demo.git" },
    })
    .returning();
  githubConv = gh.id;
  const [scratch] = await db.insert(conversations).values({ ownerId, title: "scratch", kind: "agent" }).returning();
  scratchConv = scratch.id;

  proxy = await startEgressProxy({ port: 0, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
  await proxy.close();
  await git.close();
  await new Promise((r) => { api.close(r); });
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, ownerId));
  await db.delete(user).where(eq(user.id, ownerId));
  Reflect.deleteProperty(process.env, "GITHUB_WEB_URL");
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
  Reflect.deleteProperty(process.env, "EGRESS_CA_DIR");
  rmSync(dir, { recursive: true, force: true });
});

const githubCred = () => signEgressCredential({ conversationId: githubConv, ownerId });

function apiClient(credential: string) {
  return new ProxyAgent({
    uri: `http://127.0.0.1:${String(proxy.port)}`,
    token: `Basic ${Buffer.from(`sbx:${credential}`).toString("base64")}`,
    requestTls: { ca: egressCa().certPem },
  });
}

async function apiCall(credential: string, method: string, pathname: string, body?: unknown) {
  const res = await request(`https://api.github.com${pathname}`, {
    method: method as "GET",
    dispatcher: apiClient(credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: res.statusCode, text: await res.body.text() };
}

describe("the egress proxy", () => {
  it("refuses a sandbox without a valid credential", async () => {
    for (const header of [undefined, `Basic ${Buffer.from("sbx:forged.credential").toString("base64")}`]) {
      const reply = await new Promise<string>((resolve) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n${header ? `Proxy-Authorization: ${header}\r\n` : ""}\r\n`);
        });
        socket.on("data", (d) => {
          resolve(d.toString());
          socket.destroy();
        });
      });
      expect(reply).toMatch(/^HTTP\/1\.1 407/);
    }
  });

  it("clones with the owner's token, which never reaches the client", async () => {
    const clone = path.join(dir, "clone");
    const r = await gitIn(dir, githubCred(), "clone", "-q", "https://github.com/e2e/demo.git", clone);
    expect(r.ok, r.stderr).toBe(true);
    expect(git.authorizations.at(-1)).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    // Nothing in the clone or the client's environment holds the token.
    const { stdout } = await run("grep", ["-r", "-l", TOKEN, clone]).catch(() => ({ stdout: "" }));
    expect(stdout).toBe("");
    expect(JSON.stringify(gitEnv(githubCred()))).not.toContain(TOKEN);
  }, 30_000);

  it("pushes the workspace's branch, and refuses main, deletes and tags with a reason git prints", async () => {
    const clone = path.join(dir, "push-clone");
    await gitIn(dir, githubCred(), "clone", "-q", "https://github.com/e2e/demo.git", clone);
    await gitIn(clone, githubCred(), "checkout", "-q", "-b", BRANCH);
    writeFileSync(path.join(clone, "work.txt"), "work\n");
    await gitIn(clone, githubCred(), "add", ".");
    await gitIn(clone, githubCred(), "commit", "-q", "-m", "work");

    const ok = await gitIn(clone, githubCred(), "push", "origin", BRANCH);
    expect(ok.ok, ok.stderr).toBe(true);
    expect(bareHead(BRANCH)).not.toBeNull();

    const mainBefore = bareHead("main");
    const toMain = await gitIn(clone, githubCred(), "push", "origin", `${BRANCH}:main`);
    expect(toMain.ok).toBe(false);
    expect(toMain.stderr).toContain("Loxaic lets this workspace push only to refs/heads/loxaic/feature");
    expect(bareHead("main")).toBe(mainBefore);

    const del = await gitIn(clone, githubCred(), "push", "origin", "--delete", BRANCH);
    expect(del.ok).toBe(false);
    expect(del.stderr).toContain("does not let this workspace delete");
    expect(bareHead(BRANCH)).not.toBeNull();

    await gitIn(clone, githubCred(), "tag", "v1");
    const tag = await gitIn(clone, githubCred(), "push", "origin", "v1");
    expect(tag.ok).toBe(false);
  }, 60_000);

  it("lets a sandbox outside a GitHub workspace read but never push", async () => {
    const credential = signEgressCredential({ conversationId: scratchConv, ownerId });
    const clone = path.join(dir, "scratch-clone");
    expect((await gitIn(dir, credential, "clone", "-q", "https://github.com/e2e/demo.git", clone)).ok).toBe(true);
    const push = await gitIn(clone, credential, "push", "origin", "HEAD:refs/heads/x");
    expect(push.ok).toBe(false);
    expect(push.stderr).toMatch(/403|read GitHub but not write/);
  }, 30_000);

  it("adds the token to API reads and checks writes", async () => {
    apiSeen = [];
    expect((await apiCall(githubCred(), "GET", "/repos/e2e/demo")).status).toBe(200);
    expect(apiSeen.at(-1)?.auth).toBe(`token ${TOKEN}`);

    const create = (headRefName: string) => ({
      query: "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }",
      variables: { input: { repositoryId: "R_demo", baseRefName: "main", headRefName, title: "t", body: "b" } },
    });
    expect((await apiCall(githubCred(), "POST", "/graphql", create(BRANCH))).status).toBe(200);
    const wrong = await apiCall(githubCred(), "POST", "/graphql", create("main"));
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain("only from loxaic/feature");

    const merge = await apiCall(githubCred(), "POST", "/graphql", {
      query: "mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { id } } }",
      variables: { input: { pullRequestId: "PR_1" } },
    });
    expect(merge.status).toBe(403);
    expect(merge.text).toContain("mergePullRequest");

    const query = await apiCall(githubCred(), "POST", "/graphql", { query: "query { viewer { login } }" });
    expect(query.status).toBe(200);

    expect((await apiCall(githubCred(), "PATCH", "/repos/e2e/demo/pulls/1", { title: "x" })).status).toBe(200);
    expect((await apiCall(githubCred(), "PATCH", "/repos/e2e/demo/pulls/2", { title: "x" })).status).toBe(403);
    expect((await apiCall(githubCred(), "PATCH", "/repos/e2e/demo/pulls/1", { state: "closed" })).status).toBe(403);
    expect((await apiCall(githubCred(), "DELETE", "/repos/e2e/demo")).status).toBe(403);
    expect((await apiCall(githubCred(), "POST", "/repos/other/repo/pulls", { head: BRANCH })).status).toBe(403);
    // Refused requests never reached GitHub.
    expect(apiSeen.some((s) => s.method === "DELETE")).toBe(false);
  }, 30_000);

  it("tunnels to public hosts only, never to this machine's own services", async () => {
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        const auth = Buffer.from(`sbx:${githubCred()}`).toString("base64");
        socket.write(`CONNECT 127.0.0.1:5432 HTTP/1.1\r\nHost: 127.0.0.1:5432\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
      socket.on("data", (d) => {
        resolve(d.toString());
        socket.destroy();
      });
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it("stops adding the token as soon as GitHub is disconnected, not when its cache expires", async () => {
    apiSeen = [];
    await apiCall(githubCred(), "GET", "/repos/e2e/demo");
    expect(apiSeen.at(-1)?.auth).toBe(`token ${TOKEN}`);
    // What DELETE /v1/github/connection does (routes/github.ts).
    await db.delete(githubConnections).where(eq(githubConnections.userId, ownerId));
    forgetEgressToken(ownerId);
    try {
      await apiCall(githubCred(), "GET", "/repos/e2e/demo");
      expect(apiSeen.at(-1)?.auth).toBeUndefined();
    } finally {
      await upsertConnection(ownerId, { token: TOKEN, login: "octo", name: "Octo", email: null, scopes: "repo" });
      forgetEgressToken(ownerId);
    }
  });

  it("stops honouring a credential once its conversation is gone", async () => {
    const [gone] = await db.insert(conversations).values({ ownerId, title: "gone", kind: "agent" }).returning();
    const credential = signEgressCredential({ conversationId: gone.id, ownerId });
    await db.delete(conversations).where(eq(conversations.id, gone.id));
    const r = await apiCall(credential, "GET", "/repos/e2e/demo").catch((err: unknown) => ({ status: 0, text: String(err) }));
    expect(r.status).not.toBe(200);
  });
});
