import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/middleware";
import { getRepo, getViewer, listBranches, listRepos, GithubApiError } from "../github/client.ts";
import { deleteConnection, getConnection, getOwnerToken, redactToken, toApi, upsertConnection } from "../github/connection.ts";

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
    return { status, message: err.message };
  }
  return { status: 502, message: (err as Error).message };
}

export function githubRoutes(app: FastifyInstance) {
  app.get("/v1/github/connection", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const row = await getConnection(userId);
    return row ? toApi(row) : null;
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
      return toApi(row);
    } catch (err) {
      const { status, message } = connectionError(err);
      reply.code(status);
      return { error: redactToken(message, token) };
    }
  });

  app.delete("/v1/github/connection", async (request, reply) => {
    const userId = await authenticate(request, reply);
    await deleteConnection(userId);
    return { ok: true };
  });

  app.get("/v1/github/repos", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const token = await getOwnerToken(userId);
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
      const token = await getOwnerToken(userId);
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
        reply.code(status);
        return { error: redactToken(message, token) };
      }
    },
  );
}
