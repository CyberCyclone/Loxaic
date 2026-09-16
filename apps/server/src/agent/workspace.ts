/**
 * Where an agent conversation's files live — parsed once at creation, then
 * read by the prompt builder and the sandbox manager.
 *
 * A workspace is immutable after creation and there is no PATCH path for it,
 * on purpose. The system prompt is derived from it, and a prompt that changes
 * partway through a conversation invalidates the backend's cached prefix from
 * the first token onward (AGENTS.md, "Prompt caching"). Changing your mind
 * means a new conversation.
 */
import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import type { SandboxMode } from "../sandbox/provider.ts";
import { getConnection } from "../github/connection.ts";
import { getOwnerToken, GithubTokenUnreadableError } from "../github/connection.ts";
import { getBranch, getRepo, GithubApiError } from "../github/client.ts";
import { describeGithubPermissionFailure } from "../github/permissions.ts";
import { getExecutor } from "../executor/registry.ts";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const SCRATCH: Workspace = { kind: "scratch" };

/**
 * `owner/name` — the only shape GitHub itself accepts. `.` and `..` are
 * excluded as whole segments explicitly: `[\w.-]+` admits them, and
 * `repos/../user` normalises to `/user` in the API URL — a 200 whose body is
 * the viewer, not a repository, which then persisted a workspace with an
 * undefined repo and clone URL.
 */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
function isRepoSlug(value: string): boolean {
  if (!REPO_RE.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

/**
 * A branch name git would accept. The subset of `git check-ref-format` that
 * matters for a name we are about to hand to `checkout -b`: no path-traversal
 * lookalikes, nothing that reads as an option, none of the characters git
 * reserves for refspecs and reflogs.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("@{") || name === "@") return false;
  // Control characters, space, and git's reserved set.
  // eslint-disable-next-line no-control-regex -- the point is to reject them.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return true;
}

function randomBranchSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}

/**
 * Narrows a client's workspace request into one the server has verified.
 *
 * For `github`, everything that matters comes from GitHub, not the client:
 * the repo is looked up with the owner's own token (so a repo they cannot see
 * is a 404 here, not a clone failure later), `cloneUrl` is what GitHub reports
 * for it, and `baseBranch` defaults to the repo's default branch. The client
 * chooses only the repo and, optionally, which branches.
 */
export async function parseWorkspaceInput(raw: unknown, ctx: { userId: string }): Promise<Workspace> {
  if (raw === undefined || raw === null) return SCRATCH;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceError("workspace must be an object");
  }
  const input = raw as Record<string, unknown>;

  if (input.kind === "scratch") return SCRATCH;

  if (input.kind === "github") {
    if (typeof input.repo !== "string" || !isRepoSlug(input.repo)) {
      throw new WorkspaceError("workspace.repo must be owner/name");
    }
    // The new branch's name depends on nothing GitHub knows, so it is checked
    // before any request goes out — a bad name should not cost a round trip.
    const branch = input.branch === undefined ? `loxaic/${randomBranchSuffix()}` : input.branch;
    if (typeof branch !== "string" || !isValidBranchName(branch)) {
      throw new WorkspaceError("workspace.branch is not a valid branch name");
    }
    const connection = await getConnection(ctx.userId);
    let token: string | null;
    try {
      token = await getOwnerToken(ctx.userId);
    } catch (err) {
      if (err instanceof GithubTokenUnreadableError) throw new WorkspaceError(err.message);
      throw err;
    }
    if (!connection || !token) {
      throw new WorkspaceError("GitHub is not connected — connect it in Settings first");
    }
    const [owner, name] = input.repo.split("/");
    let repo;
    try {
      repo = await getRepo(token, owner, name);
    } catch (err) {
      throw new WorkspaceError(`GitHub could not find ${input.repo}: ${(err as Error).message}`);
    }
    // The answer has to *be* a repository. Anything a lookup surprise hands
    // back — the viewer object, an error body with a 200 — is refused here,
    // as a 400 at creation, rather than persisted as a workspace whose system
    // prompt says "a clone of undefined" over an empty directory.
    if (typeof repo.full_name !== "string" || typeof repo.clone_url !== "string" || typeof repo.default_branch !== "string") {
      throw new WorkspaceError(`GitHub did not describe ${input.repo} as a repository`);
    }

    const baseBranch = input.baseBranch === undefined ? repo.default_branch : input.baseBranch;
    if (typeof baseBranch !== "string" || !isValidBranchName(baseBranch)) {
      throw new WorkspaceError("workspace.baseBranch is not a valid branch name");
    }
    if (branch === baseBranch) {
      throw new WorkspaceError("workspace.branch must differ from baseBranch — the agent works on its own branch");
    }

    // The lookup above only proves `Metadata: read`. Cloning needs
    // `Contents: read`, and until this check nothing between here and a
    // container ever asked for it — so a fine-grained token holding Metadata
    // alone got a green "Connected", a repository listed in the picker, a
    // workspace created, and a `git clone` that failed minutes later inside a
    // sandbox, reported only as GitHub's own misleading "Write access to
    // repository not granted". One request settles both remaining questions:
    // 403 is the missing permission, 404 is a base branch that is not there,
    // 200 is both fine.
    try {
      await getBranch(token, owner, name, baseBranch);
    } catch (err) {
      const status = err instanceof GithubApiError ? err.status : undefined;
      const permission = describeGithubPermissionFailure({
        status,
        message: (err as Error).message,
        repo: repo.full_name,
        need: "contents-read",
      });
      if (permission) throw new WorkspaceError(permission);
      if (status === 404) {
        throw new WorkspaceError(`GitHub has no branch named ${baseBranch} in ${repo.full_name}.`);
      }
      throw new WorkspaceError(`GitHub could not check ${repo.full_name}: ${(err as Error).message}`);
    }
    // `pr` is deliberately not read from the input: it is written by the
    // server when a pull request is opened, and a client claiming one exists
    // would make the Inspector link to a PR that was never created.
    return { kind: "github", repo: repo.full_name, baseBranch, branch, cloneUrl: repo.clone_url };
  }

  if (input.kind === "local") {
    if (typeof input.executorId !== "string" || input.executorId.length === 0) {
      throw new WorkspaceError("workspace.executorId must name one of your connected machines");
    }
    // The machine must be connected *now* and be this user's: a workspace
    // can only be created against a live executor, so "which folders are
    // allowed" is answered by that machine rather than taken on trust.
    const executor = getExecutor(input.executorId);
    if (executor?.userId !== ctx.userId) {
      throw new WorkspaceError("That machine is not connected — open the Loxaic desktop app on it and sign in there");
    }
    if (typeof input.path !== "string" || !isUnderAnnouncedRoot(input.path, executor.roots)) {
      throw new WorkspaceError("workspace.path must be a folder you have chosen on that machine");
    }
    const isolation = input.isolation === undefined ? "direct" : input.isolation;
    if (isolation !== "direct" && isolation !== "container") {
      throw new WorkspaceError("workspace.isolation must be direct or container");
    }
    // Asked of the machine, not assumed: it reports whether a container engine
    // is actually running there, and a workspace that cannot be created is
    // better refused now than on the first tool call.
    if (isolation === "container" && !executor.capabilities.container) {
      throw new WorkspaceError(
        "That machine has no container engine running — start Docker or Podman there, or choose Direct.",
      );
    }
    // `executorName` comes from the live executor, never the client: it
    // goes into the system prompt, and a client naming the machine could
    // put anything there.
    return { kind: "local", executorId: input.executorId, executorName: executor.name, path: input.path, isolation };
  }

  throw new WorkspaceError("workspace.kind must be one of scratch, github, local");
}

/**
 * Lexically under one of the roots the executor announced. Advisory: the
 * executor's own realpath check (executor/service.ts) is what actually
 * decides, on every call, and it does not trust this server's answer. What
 * this buys is a 400 at creation instead of a failed first tool call — and a
 * refusal to even *store* a path the machine has not agreed to. Separator
 * follows the root, since the executor may not run on this OS.
 */
export function isUnderAnnouncedRoot(candidate: string, roots: string[]): boolean {
  if (candidate.length === 0 || candidate.includes("\0")) return false;
  const segments = candidate.split(/[\\/]/);
  if (segments.includes("..")) return false;
  for (const root of roots) {
    const sep = root.startsWith("/") ? "/" : "\\";
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    if (candidate === base || candidate === root || candidate.startsWith(base + sep)) return true;
  }
  return false;
}

/** A stored row's workspace, with the pre-workspace null read as scratch. */
export function effectiveWorkspace(raw: unknown): Workspace {
  if (!raw || typeof raw !== "object") return SCRATCH;
  const ws = raw as Partial<Workspace>;
  if (ws.kind === "github" || ws.kind === "local") return ws as Workspace;
  return SCRATCH;
}

export async function loadWorkspace(
  conversationId: string,
): Promise<{ ownerId: string; workspace: Workspace } | null> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { ownerId: true, workspace: true },
  });
  if (!row) return null;
  return { ownerId: row.ownerId, workspace: effectiveWorkspace(row.workspace) };
}

/**
 * Records that a pull request was opened for this conversation's workspace.
 * The only way `workspace.pr` is ever written — never from a client, and
 * never anywhere but here, so "has a PR been opened" always means "did the
 * server's own createPull call succeed".
 *
 * Not a system-prompt input (see describeWorkspace's doc comment): this is
 * live state, and the prompt may only depend on what was true at creation.
 */
export async function setWorkspacePr(
  conversationId: string,
  pr: { number: number; url: string },
): Promise<void> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { workspace: true },
  });
  const workspace = effectiveWorkspace(row?.workspace);
  if (workspace.kind !== "github") return;
  await db
    .update(conversations)
    .set({ workspace: { ...workspace, pr }, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * The system-prompt sentence describing where the agent is working.
 *
 * Depends only on the immutable workspace and on which provider kind the
 * deployment runs — never on live state (whether a PR has been opened, whether
 * the sandbox is paused). Anything live would change the prompt between turns
 * and throw away the cached prefix. The container path is quoted literally
 * because it is fixed; the host path is not known until the sandbox exists,
 * so it is described rather than named.
 */
export function describeWorkspace(workspace: Workspace, mode: SandboxMode): string {
  const container = mode !== "host";
  const where = container
    ? "inside an isolated Linux sandbox container"
    : "directly on the host machine";
  const dir = container ? "/home/loxaic/repo (your working directory; relative paths resolve there)" : "your working directory";

  switch (workspace.kind) {
    case "scratch":
      return (
        `${where}. ${capitalize(dir)} is an empty scratch workspace, not a checked-out project. ` +
        "It belongs to this conversation and is kept between messages."
      );
    case "github":
      return (
        `${where}. ${capitalize(dir)} is a clone of the GitHub repository ${workspace.repo}, ` +
        `checked out on branch ${workspace.branch}, which was created from ${workspace.baseBranch}. ` +
        "Commit your work with clear messages as you go. Do not push, create other branches, or open " +
        "pull requests — the user does that from the interface."
      );
    case "local":
      return workspace.isolation === "container"
        ? (
            `on the user's own machine (${workspace.executorName}), inside an isolated container ` +
            `with their directory ${workspace.path} mounted at /home/loxaic/repo (your working ` +
            "directory; relative paths resolve there). Changes to that directory are real and " +
            "immediate; nothing else on their machine is visible to you."
          )
        : (
            `directly on the user's own machine (${workspace.executorName}), in their directory ` +
            `${workspace.path}, with no sandbox. Every change you make is immediate and real.`
          );
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
