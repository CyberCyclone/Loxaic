import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { githubConnections, user } from "@loxaic/db/schema";
import { upsertConnection } from "../../github/connection.ts";
import {
  describeWorkspace,
  effectiveWorkspace,
  isUnderAnnouncedRoot,
  isValidBranchName,
  parseWorkspaceInput,
  WorkspaceError,
} from "../workspace.ts";
import { __resetExecutorsForTest, registerExecutor } from "../../executor/registry.ts";

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
    } else if (url === "/repos/octo/notarepo") {
      // A 200 whose body is not a repository — the shape a `/repos/../user`
      // lookup used to come back with.
      res.end(JSON.stringify({ login: "octo" }));
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
    } else if (url === "/repos/octo/real/branches/trunk") {
      // The workspace pre-flight asks for the base branch by name, because
      // that single call is the one thing that proves `Contents: read` before
      // a clone is attempted. Without this route every github case here would
      // now be refused for a branch the fixture does have.
      res.end(JSON.stringify({ name: "trunk" }));
    } else if (url === "/repos/octo/forbidden") {
      // Visible on `Metadata: read` alone — the exact trap: the repo resolves
      // perfectly well and its contents are refused.
      res.end(
        JSON.stringify({
          id: 2,
          full_name: "octo/forbidden",
          private: true,
          default_branch: "main",
          clone_url: "https://github.example/octo/forbidden.git",
        }),
      );
    } else if (url === "/repos/octo/forbidden/branches/main") {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: "Resource not accessible by personal access token" }));
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

  it("refuses a repo slug with a traversal segment before ever asking GitHub", async () => {
    // `[\w.-]+` admits `..`, and `repos/../user` normalises to `/user` in the
    // API URL — a 200 whose body is the viewer, persisted as a workspace with
    // an undefined repo and clone URL.
    for (const repo of ["../user", "octo/..", "./x", "octo/."]) {
      await expect(parseWorkspaceInput({ kind: "github", repo }, { userId })).rejects.toThrow(
        "workspace.repo must be owner/name",
      );
    }
  });

  it("refuses a lookup whose answer is not a repository, rather than persisting it", async () => {
    await connect();
    await expect(parseWorkspaceInput({ kind: "github", repo: "octo/notarepo" }, { userId })).rejects.toThrow(
      "did not describe octo/notarepo as a repository",
    );
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

  it("refuses a token that can see the repo but not its contents, before anything is cloned", async () => {
    await connect();
    // The whole point of the pre-flight: `Metadata: read` resolves the
    // repository, so every earlier check passed and the clone still could not
    // happen. This used to be discovered inside a container, minutes later,
    // and reported only as git's own "Write access ... not granted".
    await expect(parseWorkspaceInput({ kind: "github", repo: "octo/forbidden" }, { userId })).rejects.toThrow(
      /Contents: Read/,
    );
  });

  it("refuses a base branch GitHub does not have", async () => {
    await connect();
    await expect(
      parseWorkspaceInput({ kind: "github", repo: "octo/real", baseBranch: "nope" }, { userId }),
    ).rejects.toThrow(/no branch named nope/);
  });

  it("never stores a client-supplied pr", async () => {
    await connect();
    const ws = await parseWorkspaceInput(
      { kind: "github", repo: "octo/real", pr: { number: 1, url: "https://x" } },
      { userId },
    );
    expect(ws).not.toHaveProperty("pr");
  });

  describe("local", () => {
    afterEach(() => { __resetExecutorsForTest(); });

    function connectMachine(owner = userId, container = false) {
      return registerExecutor({
        executorId: "laptop-1",
        userId: owner,
        name: "Casey's laptop",
        platform: "darwin",
        capabilities: { direct: true, container },
        roots: ["/Users/casey/code", "C:\\work"],
        send: () => undefined,
        close: () => undefined,
      });
    }

    it("refuses a machine that is not connected, with a reason a client can show", async () => {
      await expect(parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app" }, { userId })).rejects.toThrow(
        /not connected — open the Loxaic desktop app/,
      );
    });

    it("refuses another user's machine, indistinguishably from one that is not connected", async () => {
      connectMachine("someone-else");
      await expect(parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app" }, { userId })).rejects.toThrow(
        /not connected/,
      );
    });

    it("refuses a path outside every folder the machine announced", async () => {
      connectMachine();
      for (const bad of ["/Users/casey/.ssh", "/Users/casey/code-evil/x", "/Users/casey/code/../.ssh", "code/app", ""]) {
        await expect(parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: bad }, { userId })).rejects.toThrow(
          /folder you have chosen/,
        );
      }
    });

    it("takes the machine's name from the live executor, never the client, and defaults to direct", async () => {
      connectMachine();
      const ws = await parseWorkspaceInput(
        { kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app", executorName: "Evil Corp" },
        { userId },
      );
      expect(ws).toEqual({
        kind: "local",
        executorId: "laptop-1",
        executorName: "Casey's laptop",
        path: "/Users/casey/code/app",
        isolation: "direct",
      });
    });

    it("accepts the root itself, and follows the root's own separator", async () => {
      connectMachine();
      await expect(parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code" }, { userId })).resolves.toMatchObject({ path: "/Users/casey/code" });
      await expect(parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "C:\\work\\app" }, { userId })).resolves.toMatchObject({ path: "C:\\work\\app" });
    });

    it("refuses container isolation on a machine with no container engine, and names the fix", async () => {
      connectMachine(userId, false);
      await expect(
        parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app", isolation: "container" }, { userId }),
      ).rejects.toThrow(/no container engine running/);
    });

    it("accepts it when the machine says it has one", async () => {
      connectMachine(userId, true);
      await expect(
        parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app", isolation: "container" }, { userId }),
      ).resolves.toMatchObject({ isolation: "container" });
    });

    it("refuses an isolation it has never heard of", async () => {
      connectMachine();
      await expect(
        parseWorkspaceInput({ kind: "local", executorId: "laptop-1", path: "/Users/casey/code/app", isolation: "vm" }, { userId }),
      ).rejects.toThrow(/direct or container/);
    });
  });
});

describe("isUnderAnnouncedRoot", () => {
  it("is lexical, separator-aware, and never fooled by a shared prefix", () => {
    expect(isUnderAnnouncedRoot("/a/b", ["/a"])).toBe(true);
    expect(isUnderAnnouncedRoot("/a", ["/a/"])).toBe(true);
    expect(isUnderAnnouncedRoot("/ab", ["/a"])).toBe(false);
    expect(isUnderAnnouncedRoot("/a/../b", ["/a"])).toBe(false);
    expect(isUnderAnnouncedRoot("C:\\w\\x", ["C:\\w"])).toBe(true);
    expect(isUnderAnnouncedRoot("C:\\wx", ["C:\\w"])).toBe(false);
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

  it("says a container-isolated local workspace is one, and where the folder is mounted", () => {
    const local = {
      kind: "local" as const,
      executorId: "id",
      executorName: "Casey's laptop",
      path: "/Users/casey/code/app",
      isolation: "container" as const,
    };
    const text = describeWorkspace(local, "container");
    expect(text).toContain("Casey's laptop");
    expect(text).toContain("/Users/casey/code/app");
    expect(text).toContain("/home/loxaic/repo");
    // The direct-mode sentence would be a lie here, and the model acts on it.
    expect(text).not.toMatch(/no sandbox/);
    expect(text).toMatch(/nothing else on their machine is visible/);
  });

  it("describes a local workspace by the machine and directory fixed at creation, whatever the server's mode", () => {
    const local = { kind: "local" as const, executorId: "id", executorName: "Casey's laptop", path: "/Users/casey/code/app", isolation: "direct" as const };
    const text = describeWorkspace(local, "container");
    expect(text).toContain("Casey's laptop");
    expect(text).toContain("/Users/casey/code/app");
    expect(text).toMatch(/no sandbox/);
    // The server's own sandbox mode is not a fact about the user's machine.
    expect(describeWorkspace(local, "off")).toBe(text);
    expect(describeWorkspace(local, "host")).toBe(text);
  });
});
