import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, githubConnections, user } from "@loxaic/db/schema";
import type { ProjectInstructions, Workspace } from "@loxaic/types";
import { upsertConnection } from "../../github/connection.ts";
import {
  __resetExecutorsForTest,
  handleExecutorResult,
  registerExecutor,
} from "../../executor/registry.ts";
import { createExecutorService } from "../../executor/service.ts";
import type { ServerToExecutor } from "../../executor/protocol.ts";
import {
  ensureInstructions,
  INSTRUCTIONS_SUMMARY_COLUMN,
  instructionTokens,
  MAX_INSTRUCTIONS_SOURCE_BYTES,
  retryDelayMs,
  summarizeInstructions,
} from "../instructions.ts";
import { agentSystemPrompt } from "../../streams/runs/agentRun.ts";
import type { SandboxHandle } from "../../sandbox/provider.ts";

/** A container-isolated folder's container, standing in for one: its handle
 * runs commands in a directory of the test's choosing, as the container's
 * own view of the mounted folder. Everything else uses the real manager. */
const container = vi.hoisted(() => ({ live: null as null | { exec: (command: string[]) => Promise<unknown> } }));
vi.mock("../sandbox-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox-manager.ts")>();
  return {
    ...actual,
    attachActiveSandbox: (convId: string) =>
      container.live ? Promise.resolve(container.live) : actual.attachActiveSandbox(convId),
  };
});

/** A handle whose commands run in `dir`, as a container's do in its workdir. */
function handleIn(dir: string): SandboxHandle {
  return {
    exec: (command: string[]) => {
      const r = spawnSync(command[0], command.slice(1), { cwd: dir, encoding: "utf8" });
      return Promise.resolve({ stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 });
    },
  } as unknown as SandboxHandle;
}

process.env.MCP_ENCRYPTION_KEY ??= "instructions-test-key";

/**
 * Taking the snapshot: once, before the first request, from wherever the
 * workspace's files really are — GitHub for a github workspace, the user's
 * own machine for a local one — and never again once it has succeeded.
 */
const userId = `test-instructions-${uuid()}`;
const TOKEN = `ghp_${"z9y8x7w6v5".repeat(3)}qrstu`;
let mock: Server;
let hits: string[] = [];
/** Called with each request's path, before it is answered. */
let onRequest: (path: string) => void = () => undefined;
/** repo → file → body, or a status to answer with. */
let files: Partial<Record<string, Record<string, string | number>>> = {};

beforeAll(async () => {
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${url.pathname}${url.search}`);
    onRequest(url.pathname);
    const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    const entry = m ? files[m[1]]?.[decodeURIComponent(m[2])] : undefined;
    if (entry === "DIR") {
      // What GitHub sends for a directory, whatever media type was asked for.
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify([{ type: "file", name: "x.md" }]));
    } else if (typeof entry === "number") {
      res.statusCode = entry;
      res.end(JSON.stringify({ message: `failed; token was ${req.headers.authorization ?? ""}` }));
    } else if (typeof entry === "string" && url.searchParams.get("ref") === "trunk" && req.headers.accept === "application/vnd.github.raw") {
      res.end(entry);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise<void>((r) => { mock.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((mock.address() as { port: number }).port)}`;
  await db.insert(user).values({
    id: userId, name: "Instructions", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

beforeEach(async () => {
  hits = [];
  files = {};
  onRequest = () => undefined;
  await upsertConnection(userId, { token: TOKEN, login: "octo", name: null, email: null, scopes: "repo" });
});

afterEach(async () => {
  container.live = null;
  __resetExecutorsForTest();
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await new Promise((r) => { mock.close(r); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
});

const github: Workspace = {
  kind: "github", repo: "octo/real", baseBranch: "trunk", branch: "loxaic/abc", cloneUrl: "https://github.example/octo/real.git",
};

async function conversation(workspace: Workspace | null): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: userId, kind: "agent", workspace }).returning();
  return row.id;
}

async function stored(id: string): Promise<ProjectInstructions | null> {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id), columns: { instructions: true } });
  return (row?.instructions ?? null) as ProjectInstructions | null;
}

describe("a github workspace", () => {
  it("reads AGENTS.md at the base branch, stores it, and never asks again", async () => {
    files["octo/real"] = { "AGENTS.md": "# Rules\nUse pnpm.\n" };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap).toMatchObject({ status: "found", path: "AGENTS.md", text: "# Rules\nUse pnpm.\n", sourceTruncated: false });
    expect(await stored(id)).toMatchObject({ status: "found", path: "AGENTS.md" });
    const asked = hits.length;
    await ensureInstructions(id, userId, github);
    expect(hits.length).toBe(asked);
  });

  it("falls back to CLAUDE.md only when there is no AGENTS.md", async () => {
    files["octo/real"] = { "CLAUDE.md": "claude rules" };
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "found", path: "CLAUDE.md" });
  });

  it("takes Codex's override first, then AGENTS.md, CLAUDE.md, GEMINI.md, and Copilot's file last", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "AGENTS.override.md": "o", "AGENTS.md": "a", "CLAUDE.md": "c" }, "AGENTS.override.md"],
      [{ "AGENTS.md": "a", "CLAUDE.md": "c", "GEMINI.md": "g" }, "AGENTS.md"],
      [{ "CLAUDE.md": "c", "GEMINI.md": "g" }, "CLAUDE.md"],
      [{ "GEMINI.md": "g", ".github/copilot-instructions.md": "p" }, "GEMINI.md"],
      [{ ".github/copilot-instructions.md": "copilot rules" }, ".github/copilot-instructions.md"],
    ];
    for (const [present, expected] of cases) {
      files["octo/real"] = present;
      const id = await conversation(github);
      const snap = await ensureInstructions(id, userId, github);
      expect({ present: Object.keys(present), path: snap?.status === "found" ? snap.path : null }).toEqual({
        present: Object.keys(present),
        path: expected,
      });
    }
  });

  it("follows a CLAUDE.md's imports through the same API, and not a directory's listing", async () => {
    files["octo/real"] = {
      "CLAUDE.md": "See @docs/rules.md, @docs and @someone.\n",
      "docs/rules.md": "# Rules\nAlso @../extra.md\n",
      "extra.md": "extra rules",
      docs: "DIR",
    };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap?.status === "found" && snap.imports?.map((i) => [i.path, i.importedBy])).toEqual([
      ["docs/rules.md", "CLAUDE.md"],
      ["extra.md", "docs/rules.md"],
    ]);
  });

  it("follows nothing from AGENTS.md", async () => {
    files["octo/real"] = { "AGENTS.md": "Uses @docs/rules.md\n", "docs/rules.md": "rules" };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap).toMatchObject({ status: "found", path: "AGENTS.md" });
    expect(snap?.status === "found" && snap.imports).toBeUndefined();
  });

  it("records that there is none, so it is not looked for again", async () => {
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "none" });
    const asked = hits.length;
    await ensureInstructions(id, userId, github);
    expect(hits.length).toBe(asked);
  });

  it("reads a huge file only up to the cap and says so", async () => {
    files["octo/real"] = { "AGENTS.md": "a".repeat(MAX_INSTRUCTIONS_SOURCE_BYTES + 5000) };
    const id = await conversation(github);
    const snap = await ensureInstructions(id, userId, github);
    expect(snap).toMatchObject({ status: "found", sourceTruncated: true, sourceBytes: MAX_INSTRUCTIONS_SOURCE_BYTES });
  });

  it("records a failure, does not ask again until the retry is due, then asks and replaces it", async () => {
    files["octo/real"] = { "AGENTS.md": 500 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const id = await conversation(github);
      let t = Date.parse("2026-09-28T00:00:00Z");
      const clock = () => t;
      expect(await ensureInstructions(id, userId, github, undefined, clock)).toMatchObject({
        status: "unavailable",
        reason: "error",
        attempts: 1,
        retryAfter: "2026-09-28T00:01:00.000Z",
      });
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);

      // Before the retry is due: no lookup at all, not five seconds of one.
      const asked = hits.length;
      t += 30_000;
      expect(await ensureInstructions(id, userId, github, undefined, clock)).toMatchObject({ status: "unavailable", attempts: 1 });
      expect(hits.length).toBe(asked);

      // Due, still failing: the wait doubles.
      t += 31_000;
      expect(await ensureInstructions(id, userId, github, undefined, clock)).toMatchObject({ attempts: 2, retryAfter: new Date(t + 120_000).toISOString() });

      // Due again, and it works: the failure is replaced by the file.
      files["octo/real"] = { "AGENTS.md": "now it works" };
      t += 121_000;
      expect(await ensureInstructions(id, userId, github, undefined, clock)).toMatchObject({ status: "found", text: "now it works" });
      expect(await stored(id)).toMatchObject({ status: "found" });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a file found when a lower-priority name fails, but not when a higher one does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      files["octo/real"] = { "AGENTS.md": "found it", "GEMINI.md": 502, ".github/copilot-instructions.md": 500 };
      const a = await conversation(github);
      expect(await ensureInstructions(a, userId, github)).toMatchObject({ status: "found", path: "AGENTS.md" });
      files["octo/real"] = { "AGENTS.override.md": 502, "AGENTS.md": "found it" };
      const b = await conversation(github);
      // The override might exist and would win — not knowing is not "AGENTS.md".
      expect(await ensureInstructions(b, userId, github)).toMatchObject({ status: "unavailable" });
    } finally {
      warn.mockRestore();
    }
  });

  it("records that it could not ask without a GitHub connection, and asks nothing", async () => {
    await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
    const id = await conversation(github);
    expect(await ensureInstructions(id, userId, github)).toMatchObject({ status: "unavailable", reason: "no-github-connection" });
    expect(hits).toEqual([]);
  });

  it("stores the token count, and a listing reads the summary without the text", async () => {
    files["octo/real"] = { "AGENTS.md": "# Rules\nUse pnpm, always.\n" };
    const id = await conversation(github);
    await ensureInstructions(id, userId, github);
    const [row] = await db
      .select({ instructions: INSTRUCTIONS_SUMMARY_COLUMN })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(JSON.stringify(row.instructions)).not.toContain("Use pnpm");
    expect(summarizeInstructions(row.instructions)).toEqual({
      status: "found", path: "AGENTS.md", mode: null, tokens: instructionTokens("# Rules\nUse pnpm, always.\n"),
      sourceBytes: 26, sourceTruncated: false, imports: 0,
    });
  });

  it("keeps the root file when an import cannot be read", async () => {
    files["octo/real"] = { "CLAUDE.md": "@docs/a.md @docs/b.md\n", "docs/a.md": 502, "docs/b.md": "b rules" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const id = await conversation(github);
      const snap = await ensureInstructions(id, userId, github);
      expect(snap).toMatchObject({ status: "found", path: "CLAUDE.md" });
      expect(snap?.status === "found" && snap.imports?.map((i) => i.path)).toEqual(["docs/b.md"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("stores nothing when the run is stopped between the file and its imports", async () => {
    files["octo/real"] = { "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "a" };
    const id = await conversation(github);
    const stop = new AbortController();
    // Stop lands after CLAUDE.md was read, as its import is asked for: the
    // import's read fails and is left out, and that must not be frozen.
    onRequest = (path) => { if (path.endsWith("/docs/a.md")) stop.abort(); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await ensureInstructions(id, userId, github, stop.signal)).toBeNull();
      expect(await stored(id)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("lists a conversation without its imports' texts, and still counts them", async () => {
    files["octo/real"] = { "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "IMPORTED TEXT" };
    const id = await conversation(github);
    await ensureInstructions(id, userId, github);
    const [row] = await db.select({ instructions: INSTRUCTIONS_SUMMARY_COLUMN }).from(conversations).where(eq(conversations.id, id));
    expect(JSON.stringify(row.instructions)).not.toContain("IMPORTED TEXT");
    expect(summarizeInstructions(row.instructions)).toMatchObject({ status: "found", imports: 1 });
  });
});

describe("other workspaces", () => {
  it("has nothing to read in scratch", async () => {
    const id = await conversation(null);
    expect(await ensureInstructions(id, userId, { kind: "scratch" })).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  describe("a local folder", () => {
    let root: string;
    beforeEach(() => { root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-local-"))); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    /** The desktop's executor, in process, over a real directory — only the
     * socket elided (the executor-provider.test.ts pattern). Every call's
     * method is recorded in `calls`. */
    function connectMachine(roots: string[], calls: string[] = []): void {
      const service = createExecutorService({ roots: () => roots, executorId: "laptop-instr" });
      registerExecutor({
        executorId: "laptop-instr", userId, name: "Laptop", platform: process.platform,
        capabilities: { direct: true, container: false }, roots,
        send(message: ServerToExecutor) {
          if (message.type !== "call") return;
          calls.push(message.method);
          void service.handle(message.method, message.params)
            .then((value) => { handleExecutorResult("laptop-instr", { type: "result", id: message.id, ok: true, value }); })
            .catch((err: unknown) => { handleExecutorResult("laptop-instr", { type: "result", id: message.id, ok: false, error: (err as Error).message }); });
        },
        close: () => undefined,
      });
    }

    const local = (): Workspace => ({ kind: "local", executorId: "laptop-instr", executorName: "Laptop", path: root, isolation: "direct" });

    it("reads the folder's AGENTS.md on the user's machine, with no sandbox created", async () => {
      writeFileSync(path.join(root, "AGENTS.md"), "local rules ü\n");
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "AGENTS.md", text: "local rules ü\n" });
    });

    it("uses the same order on the user's machine, Copilot's file included", async () => {
      mkdirSync(path.join(root, ".github"));
      writeFileSync(path.join(root, ".github/copilot-instructions.md"), "copilot rules\n");
      writeFileSync(path.join(root, "GEMINI.md"), "gemini rules\n");
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "GEMINI.md" });
      rmSync(path.join(root, "GEMINI.md"));
      const id2 = await conversation(local());
      expect(await ensureInstructions(id2, userId, local())).toMatchObject({ status: "found", path: ".github/copilot-instructions.md" });
    });

    it("follows imports on the user's machine, but never through a symlink out of the folder", async () => {
      const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-outside-")));
      try {
        writeFileSync(path.join(outside, "secret.md"), "SECRET\n");
        mkdirSync(path.join(root, "docs"));
        writeFileSync(path.join(root, "docs/rules.md"), "local imported rules\n");
        symlinkSync(path.join(outside, "secret.md"), path.join(root, "docs/leak.md"));
        writeFileSync(path.join(root, "CLAUDE.md"), "@docs/rules.md\n@docs/leak.md\n");
        connectMachine([root]);
        const id = await conversation(local());
        const snap = await ensureInstructions(id, userId, local());
        expect(snap?.status === "found" && snap.imports?.map((i) => [i.path, i.text])).toEqual([
          ["docs/rules.md", "local imported rules\n"],
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("never reads the root file through a symlink out of the folder, and moves on to the next name", async () => {
      // An untrusted repository's AGENTS.md pointing at a file elsewhere on
      // the machine — a private key, the desktop's secrets — must not become
      // the snapshot the prompt and the database carry.
      const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-outside-")));
      try {
        writeFileSync(path.join(outside, "id_ed25519"), "SECRET KEY\n");
        symlinkSync(path.join(outside, "id_ed25519"), path.join(root, "AGENTS.md"));
        writeFileSync(path.join(root, "CLAUDE.md"), "inside rules\n");
        connectMachine([root]);
        const id = await conversation(local());
        expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "CLAUDE.md", text: "inside rules\n" });
        expect(JSON.stringify(await stored(id))).not.toContain("SECRET");

        rmSync(path.join(root, "CLAUDE.md"));
        const id2 = await conversation(local());
        expect(await ensureInstructions(id2, userId, local())).toMatchObject({ status: "none" });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("still follows a symlink that stays inside the folder", async () => {
      // CLAUDE.md -> AGENTS.md is a common way to serve two tools one file.
      mkdirSync(path.join(root, "docs"));
      writeFileSync(path.join(root, "docs/agents.md"), "linked rules\n");
      symlinkSync("docs/agents.md", path.join(root, "AGENTS.md"));
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "found", path: "AGENTS.md", text: "linked rules\n" });
    });

    describe("isolated in a container", () => {
      const isolated = (): Workspace => ({ ...local(), isolation: "container" } as Workspace);

      it("is never read on the host: before its container runs, nothing is read or stored", async () => {
        // The folder ref is a shell on the host, which is what container
        // isolation rules out: here a symlink to a host file would resolve.
        writeFileSync(path.join(root, "AGENTS.md"), "host copy\n");
        const calls: string[] = [];
        connectMachine([root], calls);
        const id = await conversation(isolated());
        expect(await ensureInstructions(id, userId, isolated())).toBeNull();
        expect(await stored(id)).toBeNull();
        expect(calls).toEqual([]);
      });

      it("is read inside its container once that is running", async () => {
        const view = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-instr-container-")));
        try {
          writeFileSync(path.join(view, "AGENTS.md"), "container view\n");
          writeFileSync(path.join(root, "AGENTS.md"), "host copy\n");
          const calls: string[] = [];
          connectMachine([root], calls);
          container.live = handleIn(view);
          const id = await conversation(isolated());
          expect(await ensureInstructions(id, userId, isolated())).toMatchObject({ status: "found", text: "container view\n" });
          expect(calls).toEqual([]);
        } finally {
          rmSync(view, { recursive: true, force: true });
        }
      });
    });

    it("records none for a folder without one", async () => {
      connectMachine([root]);
      const id = await conversation(local());
      expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "none" });
    });

    it("records that the machine is offline, so the client can say so", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const id = await conversation(local());
        expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "unavailable", reason: "machine-offline" });
        expect(summarizeInstructions(await stored(id))).toEqual({ status: "unavailable", reason: "machine-offline" });
      } finally {
        warn.mockRestore();
      }
    });

    it("is refused for a folder the machine no longer approves", async () => {
      writeFileSync(path.join(root, "AGENTS.md"), "secret");
      connectMachine([]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const id = await conversation(local());
        expect(await ensureInstructions(id, userId, local())).toMatchObject({ status: "unavailable", reason: "error" });
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("retrying", () => {
  it("waits a minute, doubling to an hour", () => {
    expect([1, 2, 3, 6, 7, 20].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000]);
  });
});

describe("the system prompt built from it", () => {
  it("is identical on every run of the conversation and records its decision once", async () => {
    files["octo/real"] = { "AGENTS.md": "# Rules\nUse pnpm.\n" };
    const id = await conversation(github);
    const input = { convId: id, ownerId: userId, workspace: github, mode: "manual" as const, model: "llama-3.1-8b-instruct" };
    const first = await agentSystemPrompt(input);
    expect(first).toContain('<project-instructions path="AGENTS.md" mode="full">');
    expect(first).toContain("Use pnpm.");
    const decided = await stored(id);
    expect(decided).toMatchObject({ decision: { model: "llama-3.1-8b-instruct", mode: "full" } });
    expect(await agentSystemPrompt(input)).toBe(first);
    expect(await stored(id)).toEqual(decided);
  });

  it("is the base prompt alone when there is nothing to add", async () => {
    const id = await conversation(github);
    const prompt = await agentSystemPrompt({ convId: id, ownerId: userId, workspace: github, mode: "planning", model: "m" });
    expect(prompt).not.toContain("project-instructions");
    expect(prompt).toContain("PLANNING mode");
  });
});
