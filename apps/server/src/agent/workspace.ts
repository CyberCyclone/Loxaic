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
import { getOwnerToken } from "../github/connection.ts";
import { getRepo } from "../github/client.ts";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const SCRATCH: Workspace = { kind: "scratch" };

/** `owner/name` — the only shape GitHub itself accepts. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

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
    if (typeof input.repo !== "string" || !REPO_RE.test(input.repo)) {
      throw new WorkspaceError("workspace.repo must be owner/name");
    }
    const connection = await getConnection(ctx.userId);
    const token = await getOwnerToken(ctx.userId);
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

    const baseBranch = input.baseBranch === undefined ? repo.default_branch : input.baseBranch;
    if (typeof baseBranch !== "string" || !isValidBranchName(baseBranch)) {
      throw new WorkspaceError("workspace.baseBranch is not a valid branch name");
    }
    const branch = input.branch === undefined ? `loxaic/${randomBranchSuffix()}` : input.branch;
    if (typeof branch !== "string" || !isValidBranchName(branch)) {
      throw new WorkspaceError("workspace.branch is not a valid branch name");
    }
    if (branch === baseBranch) {
      throw new WorkspaceError("workspace.branch must differ from baseBranch — the agent works on its own branch");
    }
    // `pr` is deliberately not read from the input: it is written by the
    // server when a pull request is opened, and a client claiming one exists
    // would make the Inspector link to a PR that was never created.
    return { kind: "github", repo: repo.full_name, baseBranch, branch, cloneUrl: repo.clone_url };
  }

  if (input.kind === "local") {
    // Kept as a rejection rather than an unknown kind so the client gets a
    // reason it can show, and so the type stays closed for when the desktop
    // executor lands.
    throw new WorkspaceError("Local workspaces are not available yet");
  }

  throw new WorkspaceError("workspace.kind must be one of scratch, github");
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
      return (
        `directly on the user's own machine (${workspace.executorName}), in their directory ` +
        `${workspace.path}, with no sandbox. Every change you make is immediate and real.`
      );
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
