import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { githubConnections, user } from "@loxaic/db/schema";
import { upsertConnection } from "../../github/connection.ts";
import {
  describeWorkspace,
  effectiveWorkspace,
  isValidBranchName,
  parseWorkspaceInput,
  WorkspaceError,
} from "../workspace.ts";

process.env.MCP_ENCRYPTION_KEY ??= "workspace-test-key";

/**
 * What a client may say about a workspace, and what the server refuses to
 * take its word for. The github case is the one that matters: `cloneUrl`
 * must come from GitHub's own answer, never from the request — a client that
 * could name the clone URL could point the agent's checkout anywhere.
 */
const userId = `test-workspace-${uuid()}`;
let mock: Server;

beforeAll(async () => {
  mock = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url === "/user") {
      res.end(JSON.stringify({ login: "octo", name: "Octo", email: null }));
    } else if (url === "/repos/octo/real") {
      res.end(
        JSON.stringify({
          id: 1,
          full_name: "octo/real",
          private: false,
          default_branch: "trunk",
          clone_url: "https://github.example/octo/real.git",
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise<void>((r) => { mock.listen(0, "127.0.0.1", r); });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${String((mock.address() as { port: number }).port)}`;
  await db.insert(user).values({
    id: userId,
    name: "Workspace",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(async () => {
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await new Promise((r) => { mock.close(r); });
  Reflect.deleteProperty(process.env, "GITHUB_API_URL");
});

async function connect(): Promise<void> {
  await upsertConnection(userId, { token: "tok", login: "octo", name: "Octo", email: null, scopes: "repo" });
}

describe("branch names", () => {
  it("accepts ordinary names", () => {
    for (const ok of ["main", "loxaic/ab12cd34", "feature/fix-thing", "v1.2"]) {
      expect(isValidBranchName(ok)).toBe(true);
    }
  });

  it("rejects what git would, and what would read as an option", () => {
    const bad = ["", "-rf", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a/", "/a", "a.lock", "@", "a@{b", " "];
    for (const name of bad) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });
});

describe("parseWorkspaceInput", () => {
  it("treats absent and scratch the same", async () => {
    await expect(parseWorkspaceInput(undefined, { userId })).resolves.toEqual({ kind: "scratch" });
    await expect(parseWorkspaceInput({ kind: "scratch" }, { userId })).resolves.toEqual({ kind: "scratch" });
  });

  it("refuses github without a connection, before ever asking GitHub", async () => {
    await expect(parseWorkspaceInput({ kind: "github", repo: "octo/real" }, { userId })).rejects.toThrow(
      /not connected/,
    );
  });

  it("takes cloneUrl and the default branch from GitHub, not from the client", async () => {
    await connect();
    const ws = await parseWorkspaceInput(
      { kind: "github", repo: "octo/real", cloneUrl: "https://evil.example/x.git" },
      { userId },
    );
    expect(ws.kind).toBe("github");
    if (ws.kind !== "github") throw new Error("unreachable");
    expect(ws.cloneUrl).toBe("https://github.example/octo/real.git");
    expect(ws.baseBranch).toBe("trunk");
    expect(ws.branch).toMatch(/^loxaic\/[0-9a-f]{8}$/);
  });

  it("refuses a repo GitHub cannot find under this token", async () => {
    await connect();
    await expect(parseWorkspaceInput({ kind: "github", repo: "octo/missing" }, { userId })).rejects.toThrow(
      /could not find/,
    );
  });

  it("refuses a malformed repo, a bad branch, and a branch equal to the base", async () => {
    await connect();
    await expect(parseWorkspaceInput({ kind: "github", repo: "nope" }, { userId })).rejects.toBeInstanceOf(
      WorkspaceError,
    );
    await expect(
      parseWorkspaceInput({ kind: "github", repo: "octo/real", branch: "-rf" }, { userId }),
    ).rejects.toThrow(/branch/);
    await expect(
      parseWorkspaceInput({ kind: "github", repo: "octo/real", branch: "trunk" }, { userId }),
    ).rejects.toThrow(/differ/);
  });

  it("never stores a client-supplied pr", async () => {
    await connect();
    const ws = await parseWorkspaceInput(
      { kind: "github", repo: "octo/real", pr: { number: 1, url: "https://x" } },
      { userId },
    );
    expect(ws).not.toHaveProperty("pr");
  });

  it("rejects local for now, with a reason a client can show", async () => {
    await expect(parseWorkspaceInput({ kind: "local", path: "/tmp" }, { userId })).rejects.toThrow(
      /not available yet/,
    );
  });
});

describe("effectiveWorkspace", () => {
  it("reads the pre-workspace null as scratch", () => {
    expect(effectiveWorkspace(null)).toEqual({ kind: "scratch" });
    expect(effectiveWorkspace(undefined)).toEqual({ kind: "scratch" });
    expect(effectiveWorkspace("garbage")).toEqual({ kind: "scratch" });
  });
});

describe("describeWorkspace", () => {
  const github = {
    kind: "github" as const,
    repo: "octo/real",
    baseBranch: "main",
    branch: "loxaic/x",
    cloneUrl: "u",
  };

  it("names the container path literally and describes the host path", () => {
    expect(describeWorkspace({ kind: "scratch" }, "container")).toContain("/home/loxaic/repo");
    expect(describeWorkspace({ kind: "scratch" }, "host")).not.toContain("/home/loxaic");
  });

  it("no longer claims a repository is checked out in a scratch workspace", () => {
    expect(describeWorkspace({ kind: "scratch" }, "container")).toMatch(/not a checked-out project/);
  });

  it("tells the model the repo, the branch, and that pushing is the user's job", () => {
    const text = describeWorkspace(github, "container");
    expect(text).toContain("octo/real");
    expect(text).toContain("loxaic/x");
    expect(text).toContain("main");
    expect(text).toMatch(/Do not push/);
  });

  it("is a pure function of the workspace and mode — the prefix-stability contract", () => {
    // The prompt must not vary between two turns of the same conversation.
    // Anything live (a PR having been opened, say) is deliberately excluded.
    expect(describeWorkspace({ ...github, pr: { number: 9, url: "x" } }, "container")).toBe(
      describeWorkspace(github, "container"),
    );
  });
});
