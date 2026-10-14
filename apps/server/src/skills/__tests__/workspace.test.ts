import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, githubConnections, messages, user } from "@loxaic/db/schema";
import type { ContentBlock, StreamEventKind, Workspace } from "@loxaic/types";
import { upsertConnection } from "../../github/connection.ts";
import { __resetExecutorsForTest, handleExecutorResult, registerExecutor } from "../../executor/registry.ts";
import { createExecutorService } from "../../executor/service.ts";
import type { ServerToExecutor } from "../../executor/protocol.ts";
import { collectSkills, coerceScan, MAX_LISTED_FILES, MAX_REPO_SKILL_LIST_BYTES, refreshRepoSkills } from "../workspace.ts";
import { renderSkillContent, resolveSkillCatalog } from "../catalog.ts";
import { prepareRunSkills } from "../session.ts";

process.env.MCP_ENCRYPTION_KEY ??= "skills-test-key";

/**
 * A repository's own skills, read where they really are: on the person's
 * machine through the executor for a local folder, and through GitHub's
 * contents API for a repository not yet cloned. The scan stores names and
 * descriptions only; using a skill reads its instructions from the workspace
 * then, so it runs as the checkout has it.
 */
const userId = `test-repo-skills-${uuid()}`;
const EXECUTOR = "laptop-skills";
const TOKEN = `ghp_${"a1b2c3d4e5".repeat(3)}vwxyz`;
let root = "";
let outside = "";
let mock: Server;
/** path → body, or "DIR:<json>" for a directory listing. */
let gh: Record<string, string> = {};

const skillFile = (name: string, description: string, body = `Instructions for ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

function write(rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/repos\/octo\/real\/contents\/(.+)$/.exec(url.pathname);
    const entry = m ? gh[decodeURIComponent(m[1])] : undefined;
    if (entry?.startsWith("DIR:")) {
      res.setHeader("content-type", "application/json");
      res.end(entry.slice(4));
    } else if (entry !== undefined) {
      res.end(entry);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise<void>((r) => { mock.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((mock.address() as { port: number }).port)}`;
  await db.insert(user).values({
    id: userId, name: "Repo skills", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "repo-skills-")));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "repo-skills-outside-")));
  gh = {};
  const service = createExecutorService({ roots: () => [root], executorId: EXECUTOR });
  registerExecutor({
    executorId: EXECUTOR, userId, name: "Laptop", platform: process.platform,
    capabilities: { direct: true, container: false }, roots: [root],
    send(message: ServerToExecutor) {
      if (message.type !== "call") return;
      void service.handle(message.method, message.params)
        .then((value) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: true, value }); })
        .catch((err: unknown) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: false, error: (err as Error).message }); });
    },
    close: () => undefined,
  });
});

afterEach(async () => {
  __resetExecutorsForTest();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, userId));
  for (const c of convs) await db.delete(messages).where(eq(messages.conversationId, c.id));
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await new Promise((r) => { mock.close(r); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
});

const local = (): Workspace => ({ kind: "local", executorId: EXECUTOR, executorName: "Laptop", path: root, isolation: "direct" });

async function agentConversation(workspace: Workspace): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: userId, kind: "agent", workspace }).returning();
  return row.id;
}

async function message(convId: string, text: string): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({ id: uuid(), conversationId: convId, authorType: "user", authorUserId: userId, content: [{ kind: "text", text }], status: "complete", lamport: Date.now() })
    .returning();
  return row.id;
}

async function blocksOf(id: string): Promise<ContentBlock[]> {
  return ((await db.query.messages.findFirst({ where: eq(messages.id, id) }))?.content ?? []) as ContentBlock[];
}

const quiet = { emit: (_e: StreamEventKind) => undefined };

describe("collectSkills", () => {
  it("lets the first definition of a name win, and says why the others were not used", () => {
    const { skills, problems } = collectSkills([
      { dir: ".agents/skills/lint", text: skillFile("lint", "Agents' lint.") },
      { dir: ".claude/skills/lint", text: skillFile("lint", "Claude's lint.") },
      { dir: ".claude/skills/broken", text: "no frontmatter" },
    ]);
    expect(skills.map((s) => [s.name, s.description])).toEqual([["lint", "Agents' lint."]]);
    expect(problems.join("\n")).toMatch(/already defined earlier/);
    expect(problems.join("\n")).toMatch(/broken/);
  });
});

describe("a local folder's skills", () => {
  it("are found in .agents, .claude and .opencode, offered to the model, and read from the folder when used", async () => {
    write(".agents/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Lint this repo. Use before committing.", "Run npm run lint."));
    write(".agents/skills/repo-lint/scripts/check.sh", "echo ok\n");
    write(".claude/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Shadowed."));
    write(".claude/skills/deploy-notes/SKILL.md", skillFile("deploy-notes", "Write deploy notes."));
    write(".opencode/skill/old-style/SKILL.md", skillFile("old-style", "OpenCode's older folder."));
    const convId = await agentConversation(local());
    const msg = await message(convId, "hello");
    const run = await prepareRunSkills({ convId, userId, userMsgId: msg, front: "0", producer: quiet });

    const names = run.listing?.map((s) => s.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["repo-lint", "deploy-notes", "old-style", "debug"]));
    expect(run.listing?.find((s) => s.name === "repo-lint")?.description).toBe("Lint this repo. Use before committing.");

    const loaded = await run.load("repo-lint");
    expect(loaded.ok).toBe(true);
    expect(loaded.output).toMatch(/^<skill-content name="repo-lint" source="workspace">\nThis skill comes from the workspace's repository/);
    expect(loaded.output).toContain("Run npm run lint.");
    expect(loaded.output).toContain("Skill directory: .agents/skills/repo-lint");
    expect(loaded.output).toContain("- .agents/skills/repo-lint/scripts/check.sh");
  });

  it("never reads a skill that leads outside the folder", async () => {
    writeFileSync(path.join(outside, "SKILL.md"), skillFile("stolen", "Should never be seen."));
    mkdirSync(path.join(root, ".agents/skills"), { recursive: true });
    symlinkSync(outside, path.join(root, ".agents/skills/stolen"));
    write(".agents/skills/real/SKILL.md", skillFile("real", "A real one."));
    const convId = await agentConversation(local());
    const run = await prepareRunSkills({ convId, userId, userMsgId: await message(convId, "hi"), front: "0", producer: quiet });
    // Passed over, not a failed scan: the skill beside it is still found.
    expect(run.listing?.map((s) => s.name)).toContain("real");
    expect(run.listing?.map((s) => s.name)).not.toContain("stolen");
  });

  it("put a /name skill's instructions from the folder on the message, and announce an edit once", async () => {
    write(".agents/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Lint.", "Run npm run lint."));
    const convId = await agentConversation(local());
    const first = await message(convId, "/repo-lint the parser");
    await prepareRunSkills({ convId, userId, userMsgId: first, front: "0", producer: quiet });
    const invoked = (await blocksOf(first)).find((b) => b.kind === "skill");
    expect(invoked).toMatchObject({ name: "repo-lint", source: "workspace" });
    expect((invoked as { text: string }).text).toContain("Run npm run lint.");

    write(".agents/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Lint.", "Run pnpm lint."));
    const second = await message(convId, "again");
    await prepareRunSkills({ convId, userId, userMsgId: second, front: "0", producer: quiet });
    expect((await blocksOf(second))[1]).toMatchObject({ kind: "skills_update", summary: "Skills changed: changed repo-lint" });

    // Touched without a change: rescanned (its cksum moved), nothing to tell.
    write(".agents/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Lint.", "Run pnpm lint."));
    const third = await message(convId, "and again");
    await prepareRunSkills({ convId, userId, userMsgId: third, front: "0", producer: quiet });
    expect(await blocksOf(third)).toHaveLength(1);
  });

  it("are not offered to a chat, which has no workspace", async () => {
    write(".agents/skills/repo-lint/SKILL.md", skillFile("repo-lint", "Lint."));
    const [row] = await db.insert(conversations).values({ ownerId: userId, kind: "chat" }).returning();
    const run = await prepareRunSkills({ convId: row.id, userId, userMsgId: await message(row.id, "hi"), front: "0", producer: quiet });
    expect(run.listing?.map((s) => s.name)).not.toContain("repo-lint");
  });
});

describe("what a repository cannot do to a thread", () => {
  async function scanOf(convId: string) {
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, convId), columns: { repoSkills: true } });
    const scan = coerceScan(row?.repoSkills);
    if (scan?.status !== "scanned") throw new Error(`no scan: ${JSON.stringify(scan)}`);
    return scan;
  }

  it("cannot replace /compact, so the thread keeps manual compaction", async () => {
    write(".agents/skills/compact/SKILL.md", skillFile("compact", "Our own way to compact."));
    write(".agents/skills/lint/SKILL.md", skillFile("lint", "Lint."));
    const convId = await agentConversation(local());
    await refreshRepoSkills({ convId, ownerId: userId, workspace: local() });
    const scan = await scanOf(convId);
    expect(scan.skills.map((x) => x.name)).toEqual(["lint"]);
    expect(scan.problems?.join("\n")).toMatch(/"\/compact" is Loxaic's own command/);
    const compact = (await resolveSkillCatalog({ ownerId: userId, conversationId: convId })).find((x) => x.name === "compact");
    expect(compact).toMatchObject({ source: "builtin", action: "compact" });
  });

  it("lists descriptions only up to a budget, since they ride every request", async () => {
    const long = "Describes a step of the build in great detail. ".repeat(20).trim();
    for (let i = 0; i < 20; i++) write(`.agents/skills/step-${String(i).padStart(2, "0")}/SKILL.md`, skillFile(`step-${String(i).padStart(2, "0")}`, long));
    const convId = await agentConversation(local());
    await refreshRepoSkills({ convId, ownerId: userId, workspace: local() });
    const scan = await scanOf(convId);
    const listed = scan.skills.reduce((n, x) => n + Buffer.byteLength(`- ${x.name}: ${x.description}\n`), 0);
    expect(scan.skills.length).toBeGreaterThan(0);
    expect(scan.skills.length).toBeLessThan(20);
    expect(listed).toBeLessThanOrEqual(MAX_REPO_SKILL_LIST_BYTES);
    expect(scan.problems?.join("\n")).toMatch(/already fill the 8 KB/);
  });

  it("stops scanning at its time budget and says what it did not read", async () => {
    for (const name of ["a-one", "b-two", "c-three"]) write(`.agents/skills/${name}/SKILL.md`, skillFile(name, "A skill."));
    const convId = await agentConversation(local());
    // Every look at the clock is 20 s later: the second read is past 30 s.
    let clock = Date.now();
    const now = () => (clock += 20_000);
    await refreshRepoSkills({ convId, ownerId: userId, workspace: local(), now });
    const scan = await scanOf(convId);
    expect(scan.skills.length).toBeGreaterThan(0);
    expect(scan.skills.length).toBeLessThan(3);
    expect(scan.problems?.join("\n")).toMatch(/the scan stopped after 30 s, before reading: .*c-three/);
  });
});

describe("a skill's other files", () => {
  async function filesOf(name: string): Promise<string[]> {
    const convId = await agentConversation(local());
    const run = await prepareRunSkills({ convId, userId, userMsgId: await message(convId, "hi"), front: "0", producer: quiet });
    const loaded = await run.load(name);
    expect(loaded.ok).toBe(true);
    const at = loaded.output.indexOf("Its other files");
    return at < 0 ? [] : loaded.output.slice(at).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  }

  it("are listed for a skill linked in from elsewhere in the repository", async () => {
    // find does not descend a symlinked start; the directory is resolved first.
    write("tools/lint-skill/SKILL.md", skillFile("linked", "Linked in."));
    write("tools/lint-skill/scripts/check.sh", "echo ok\n");
    mkdirSync(path.join(root, ".agents/skills"), { recursive: true });
    symlinkSync("../../tools/lint-skill", path.join(root, ".agents/skills/linked"));
    expect(await filesOf("linked")).toEqual([".agents/skills/linked/scripts/check.sh"]);
  });

  it("are one entry each, whatever their names hold, and never the skill's own SKILL.md", async () => {
    // A newline in a name, and a directory named like a pattern.
    write(".agents/skills/a[b]/SKILL.md", skillFile("a-b", "Bracketed."));
    write(".agents/skills/a[b]/notes\nscripts/run.sh", "x");
    expect(await filesOf("a-b")).toEqual([".agents/skills/a[b]/notes scripts/run.sh"]);
  });

  it("are cut at the limit, which the listing and its notice both use", async () => {
    for (let i = 0; i <= MAX_LISTED_FILES; i++) write(`.agents/skills/many/f${String(i).padStart(3, "0")}.txt`, "x");
    write(".agents/skills/many/SKILL.md", skillFile("many", "Many files."));
    const files = await filesOf("many");
    expect(files).toHaveLength(MAX_LISTED_FILES + 1);
    expect(files.at(-1)).toBe("(and more)");
    const rendered = renderSkillContent({ name: "x", source: "workspace", body: "b", dir: "d" }, Array.from({ length: MAX_LISTED_FILES }, (_, i) => `d/${String(i)}`));
    expect(rendered).not.toContain("(and more)");
  });
});

describe("a github repository's skills, before it is cloned", () => {
  const github: Workspace = {
    kind: "github", repo: "octo/real", baseBranch: "trunk", branch: "loxaic/x", cloneUrl: "https://github.example/octo/real.git",
  };

  it("are listed through the contents API at the base branch", async () => {
    await upsertConnection(userId, { token: TOKEN, login: "octo", name: null, email: null, scopes: "repo" });
    gh = {
      ".agents/skills": `DIR:${JSON.stringify([{ name: "release", type: "dir" }, { name: "README.md", type: "file" }])}`,
      ".agents/skills/release/SKILL.md": skillFile("release", "Cut a release."),
    };
    const convId = await agentConversation(github);
    await refreshRepoSkills({ convId, ownerId: userId, workspace: github });
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, convId), columns: { repoSkills: true } });
    const scan = coerceScan(row?.repoSkills);
    expect(scan).toMatchObject({ status: "scanned", cksums: null });
    expect(scan?.status === "scanned" && scan.skills.map((s) => [s.name, s.dir])).toEqual([["release", ".agents/skills/release"]]);
  });

  it("are not looked for without a GitHub connection, and nothing is stored", async () => {
    const convId = await agentConversation(github);
    await refreshRepoSkills({ convId, ownerId: userId, workspace: github });
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, convId), columns: { repoSkills: true } });
    expect(row?.repoSkills).toBeNull();
  });
});
