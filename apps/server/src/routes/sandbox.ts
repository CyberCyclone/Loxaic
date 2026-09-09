import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "@loxaic/db";
import { db } from "@loxaic/db";
import { sandboxes } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { resolvePath } from "../agent/executor.ts";
import {
  assertUnderUserLimit,
  attachRunningSandbox,
  releaseSandboxSlot,
  SandboxLimitError,
} from "../agent/sandbox-manager.ts";
import { getProviderByKind, getSandboxMode } from "../sandbox/provider.ts";
import type { SandboxKind } from "../sandbox/provider.ts";
import { sandboxDisabledReason, sandboxReapAt } from "../settings.ts";

export function sandboxRoutes(app: FastifyInstance) {
  // Lets a caller find the sandbox backing a conversation — agent sandboxes
  // are created lazily by the tool loop, so their id is otherwise never
  // surfaced to a client. Newest first; own rows only.
  app.get("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id } = request.query as { conversation_id?: string };
    const rows = await db.query.sandboxes.findMany({
      where: conversation_id
        ? and(eq(sandboxes.ownerId, userId), eq(sandboxes.conversationId, conversation_id))
        : eq(sandboxes.ownerId, userId),
      orderBy: desc(sandboxes.createdAt),
    });
    // reap_at is derived here rather than stored, so it always reflects the
    // policy the reaper will actually apply — see sandboxReapAt(). Null means
    // reaping is switched off, which the UI must render as "kept", never as an
    // unknown date.
    return rows.map((row) => ({
      ...row,
      reap_at: row.status === "destroyed" ? null : sandboxReapAt(row.lastUsedAt)?.toISOString() ?? null,
    }));
  });

  app.post("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { repo_url, branch, token, conversation_id } = request.body as {
      repo_url?: string;
      branch?: string;
      token?: string;
      conversation_id?: string;
    };
    // The execution model is a deployment-wide, admin-only decision (see
    // routes/admin-settings.ts) and is deliberately NOT selectable per
    // request. This route used to honour a `provider` field in the body,
    // which let ANY signed-in user ask for `provider: "host"` — arbitrary
    // command execution on the host as the server process — and, because the
    // disabled-check was skipped whenever that field was present, sidestep
    // `mode: "off"` entirely. Derive the kind from configuration only.
    const mode = getSandboxMode();
    if (mode === "off") {
      return reply.code(400).send({ error: sandboxDisabledReason() });
    }
    const kind: SandboxKind = mode;
    // Host mode has real network access unlike a container's NetworkMode:
    // none, so it *could* clone — but the REST surface is broad (any
    // signed-in user, no per-repo scoping), and giving host execution a
    // network-fetching clone step on top is a bigger step than this endpoint
    // should take without a more deliberate design. Rejected outright rather
    // than half-supported.
    if (kind === "host" && repo_url) {
      return reply.code(400).send({ error: "repo_url is not supported with provider=host" });
    }

    // The same per-user cap the tool loop enforces. This is a second creation
    // path, and a cap honoured by only one of two is not a cap: a user could
    // loop this endpoint into unbounded containers — and, because rows made
    // here are never in the in-process map the idle reaper walks, lock
    // *themselves* out of agent sandboxes with a message promising a reap
    // that would never come.
    try {
      await assertUnderUserLimit(userId);
    } catch (err) {
      if (err instanceof SandboxLimitError) return reply.code(429).send({ error: err.message });
      throw err;
    }

    try {
      const provider = await getProviderByKind(kind);
      // The body's `token` is kept for compatibility, mapped onto the config
      // shape sandbox/git.ts reads — it now travels through the exec
      // environment rather than the clone URL.
      const handle = await provider.create(userId, {
        repoUrl: repo_url,
        branch,
        ...(token ? { git: { token } } : {}),
      });

      const [row] = await db
        .insert(sandboxes)
        .values({
          ownerId: userId,
          conversationId: conversation_id ?? null,
          containerId: handle.ref,
          provider: kind,
          image: kind === "container" ? (process.env.SANDBOX_IMAGE ?? "loxaic-sandbox") : "host",
          status: "running",
          repoUrl: repo_url ?? null,
          branch: branch ?? null,
          limits: { memory: 512, cpu: 1 },
        })
        .returning();

      return row;
    } finally {
      releaseSandboxSlot(userId);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/sandboxes/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    // Destroys, not pauses. This route is a person saying "delete this",
    // which is one of exactly two things allowed to discard a workspace (the
    // other being the abandoned reaper). Idle timers use stop() instead.
    //
    // Attaches directly rather than through attachRunningSandbox(): every
    // other route here resumes a paused sandbox before touching it, which
    // would mean starting a container purely to remove it a moment later. It
    // also has to keep working when the sandbox is already gone, so that a
    // stale row can still be cleared.
    const provider = await getProviderByKind(sandbox.provider as SandboxKind);
    const handle = await provider.attach(sandbox.containerId).catch(() => null);
    await handle?.destroy().catch(() => undefined);
    await db
      .update(sandboxes)
      .set({ status: "destroyed", stoppedAt: new Date() })
      .where(eq(sandboxes.id, sandbox.id));

    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/sandboxes/:id/exec", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { command, workdir } = request.body as { command: string; workdir?: string };
    const handle = await attachRunningSandbox(sandbox);
    if (!handle) return reply.code(404).send({ error: "Not found" });
    const result = await handle.exec(["bash", "-c", command], { workdir });
    return result;
  });

  app.get<{ Params: { id: string } }>("/v1/sandboxes/:id/files", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path } = request.query as { path?: string };
    const handle = await attachRunningSandbox(sandbox);
    if (!handle) return reply.code(404).send({ error: "Not found" });
    try {
      const treePath = path ? resolvePath(handle, path) : handle.workdir;
      return await handle.fileTree(treePath);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/v1/sandboxes/:id/files/read", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path } = request.query as { path?: string };
    const handle = await attachRunningSandbox(sandbox);
    if (!handle) return reply.code(404).send({ error: "Not found" });
    let resolved: string;
    try {
      resolved = resolvePath(handle, path);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const content = await handle.readFile(resolved);
    return { content };
  });

  app.post<{ Params: { id: string } }>("/v1/sandboxes/:id/files/write", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path, content } = request.body as { path: string; content: string };
    const handle = await attachRunningSandbox(sandbox);
    if (!handle) return reply.code(404).send({ error: "Not found" });
    let resolved: string;
    try {
      resolved = resolvePath(handle, path);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    await handle.writeFile(resolved, content);
    return { ok: true };
  });
}
