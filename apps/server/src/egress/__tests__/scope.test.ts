import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, githubConnections, sandboxes, user } from "@loxaic/db/schema";
import { upsertConnection } from "../../github/connection.ts";
import { destroyConversationSandboxes, getConversationSandbox } from "../../agent/sandbox-manager.ts";
import { __forgetPreparedCaForTest, setRunningEgressProxy } from "../env.ts";
import { __resetEgressCaForTest } from "../ca.ts";

process.env.MCP_ENCRYPTION_KEY ??= "egress-scope-test-key";

/**
 * Which sandboxes are given the egress proxy: a GitHub workspace's, and no
 * other. The proxy's reads reach whatever the owner's token can, so a scratch
 * conversation given it could list and clone private repositories unasked.
 * Real host-mode sandboxes; nothing listens on the proxy port, since only the
 * environment each command is given is under test.
 */
const ownerId = `test-egress-scope-${uuid()}`;
let root = "";
const made: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-egress-scope-"));
  process.env.SANDBOX_MODE = "host";
  process.env.SANDBOX_HOST_ROOT = path.join(root, "sandboxes");
  process.env.EGRESS_CA_DIR = path.join(root, "ca");
  __resetEgressCaForTest();
  __forgetPreparedCaForTest();
  setRunningEgressProxy({ port: 9, bind: "127.0.0.1" });
  await db.insert(user).values({ id: ownerId, name: "Scope", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await upsertConnection(ownerId, { token: "tok", login: "octo", name: "Octo", email: null, scopes: "repo" });
});

afterAll(async () => {
  for (const id of made) await destroyConversationSandboxes(id);
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, ownerId));
  await db.delete(user).where(eq(user.id, ownerId));
  setRunningEgressProxy(null);
  for (const key of ["SANDBOX_MODE", "SANDBOX_HOST_ROOT", "EGRESS_CA_DIR"]) Reflect.deleteProperty(process.env, key);
  rmSync(root, { recursive: true, force: true });
});

async function conversation(workspace: unknown): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId, title: "scope", kind: "agent", workspace }).returning();
  made.push(row.id);
  return row.id;
}

function bareOrigin(): string {
  const work = path.join(root, `work-${uuid()}`);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(path.join(work, "README.md"), "hi\n");
  execFileSync("git", ["-C", work, "add", "."], { env });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "init"], { env });
  const bare = path.join(root, `origin-${uuid()}.git`);
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

async function proxyIn(conversationId: string): Promise<string | undefined> {
  const handle = await getConversationSandbox(ownerId, conversationId);
  const r = await handle.exec(["sh", "-c", "printf %s \"$HTTPS_PROXY\""]);
  return r.stdout || undefined;
}

describe("which sandboxes get the egress proxy", () => {
  it("a scratch conversation's does not", async () => {
    expect(await proxyIn(await conversation(null))).toBeUndefined();
  }, 30_000);

  it("a GitHub workspace's does", async () => {
    const id = await conversation({
      kind: "github", repo: "octo/real", baseBranch: "main", branch: "loxaic/scope", cloneUrl: `file://${bareOrigin()}`,
    });
    expect(await proxyIn(id)).toMatch(/^http:\/\/sbx:[^@]+@127\.0\.0\.1:9$/);
  }, 30_000);
});
