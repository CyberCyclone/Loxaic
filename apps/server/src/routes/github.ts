import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/middleware";
import { getRepo, getViewer, listBranches, listRepos, GithubApiError } from "../github/client.ts";
import { describeGithubPermissionFailure } from "../github/permissions.ts";
import {
  deleteConnection,
  getConnection,
  getOwnerToken,
  GithubTokenUnreadableError,
  redactToken,
  toApi,
  upsertConnection,
} from "../github/connection.ts";
import {
  describeGithubMcp,
  ensureGithubMcpServer,
  removeGithubMcpServer,
  type GithubMcpStatus,
} from "../mcp/github-server.ts";

/** Turns a client failure into the response shape the connection screen
 * needs: a message safe to show (redacted, though a viewer/listing call can
 * never echo the token back anyway) and a status that maps a bad credential
 * to 400 rather than a bare 500. */
function connectionError(err: unknown): { status: number; message: string } {
  if (err instanceof GithubApiError) {
    // 401/403/404 from GitHub all mean "this token doesn't work for this",
    // which is the caller's problem to fix, not ours — 400. Anything else
    // (rate limit, GitHub down) is a real 502.
    const status = err.status === 401 || err.status === 403 || err.status === 404 ? 400 : 502;
    // A 401 is the one case where the raw body was actively unhelpful:
    // `GitHub API 401: {"message":"Bad credentials"}` is not a sentence to put
    // in front of someone who has just pasted a token, and it names neither of
    // the two things that actually cause it.
    if (err.status === 401) {
      return {
        status,
        message: "That token was rejected by GitHub. Check you pasted it whole, and that it has not expired.",
      };
    }
    return { status, message: err.message };
  }
  return { status: 502, message: (err as Error).message };
}

/**
 * The owner's token, or `null` when nothing is connected — or `undefined`
 * after a 409 has been sent, for a token that is stored but can no longer be
 * decrypted. That case used to escape as a bare 500 from outside the `try`,
 * with the settings screen still saying "Connected as …" and nothing telling
 * the user to reconnect.
 */
async function tokenOr409(
  userId: string,
  reply: { code(status: number): unknown; send(body: unknown): unknown },
): Promise<string | null | undefined> {
  try {
    return await getOwnerToken(userId);
  } catch (err) {
    if (err instanceof GithubTokenUnreadableError) {
      reply.code(409);
      reply.send({ error: err.message });
      return undefined;
    }
    throw err;
  }
}

export function githubRoutes(app: FastifyInstance) {
  app.get("/v1/github/connection", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const row = await getConnection(userId);
    return row ? { ...toApi(row), mcp: await describeGithubMcp(userId) } : null;
  });

  app.put("/v1/github/connection", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { token } = (request.body ?? {}) as { token?: unknown };
    if (typeof token !== "string" || token.trim().length === 0) {
      reply.code(400);
      return { error: "token must be a non-empty string" };
    }
    try {
      const { viewer, scopes } = await getViewer(token);
      const row = await upsertConnection(userId, {
        token,
        login: viewer.login,
        name: viewer.name,
        email: viewer.email,
        scopes,
      });
      // Connecting GitHub also sets up its MCP tools. A failure there must not
      // fail the connection — the token still clones and pushes — so it is
      // reported beside it for the screen to show.
      let mcp: GithubMcpStatus;
      try {
        mcp = await ensureGithubMcpServer(userId);
      } catch (err) {
        mcp = { ok: false, error: `GitHub tools could not be set up: ${redactToken((err as Error).message, token)}` };
      }
      return { ...toApi(row), mcp };
    } catch (err) {
      const { status, message } = connectionError(err);
      reply.code(status);
      return { error: redactToken(message, token) };
    }
  });

  app.delete("/v1/github/connection", async (request, reply) => {
    const userId = await authenticate(request, reply);
    // The credential goes first: if the second step never runs, what is left
    // is a server row that can no longer connect (and may now be deleted by
    // hand), not a token nobody can see.
    await deleteConnection(userId);
    await removeGithubMcpServer(userId).catch((err: unknown) => {
      request.log.warn(`Could not remove the GitHub MCP server: ${(err as Error).message}`);
    });
    return { ok: true };
  });

  app.get("/v1/github/repos", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const token = await tokenOr409(userId, reply);
    if (token === undefined) return;
    if (!token) {
      reply.code(404);
      return { error: "GitHub is not connected" };
    }
    const { q } = request.query as { q?: string };
    try {
      const repos = await listRepos(token, q);
      return repos.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
      }));
    } catch (err) {
      const { status, message } = connectionError(err);
      reply.code(status);
      return { error: redactToken(message, token) };
    }
  });

  app.get<{ Params: { owner: string; repo: string } }>(
    "/v1/github/repos/:owner/:repo/branches",
    async (request, reply) => {
      const userId = await authenticate(request, reply);
      const token = await tokenOr409(userId, reply);
      if (token === undefined) return;
      if (!token) {
        reply.code(404);
        return { error: "GitHub is not connected" };
      }
      const { owner, repo } = request.params;
      try {
        const [repoInfo, branches] = await Promise.all([
          getRepo(token, owner, repo),
          listBranches(token, owner, repo),
        ]);
        return { default_branch: repoInfo.default_branch, branches };
      } catch (err) {
        const { status, message } = connectionError(err);
        // Listing branches is the first call in the whole picker flow that
        // needs `Contents: read` — the repo listing and the lookup beside it
        // need only Metadata — so a refusal here is the earliest chance to say
        // which permission is missing. Translated only on this route for that
        // reason: the same 403 on the repo listing would mean Metadata, and
        // naming Contents there would repeat the wrong-permission mistake this
        // whole change exists to fix.
        const permission =
          err instanceof GithubApiError
            ? describeGithubPermissionFailure({
                status: err.status,
                message: err.message,
                repo: `${owner}/${repo}`,
                need: "contents-read",
              })
            : null;
        reply.code(status);
        return { error: redactToken(permission ?? message, token) };
      }
    },
  );
}
