import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, ne } from "@loxaic/db";
import { db } from "@loxaic/db";
import { sandboxes } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { hasRole } from "../streams/authz";
import { resolvePath } from "../agent/executor.ts";
import {
  attachRunningSandbox,
  configNeed,
  networkFor,
  pauseSandbox,
  reserveSandbox,
  runningUsage,
} from "../agent/sandbox-manager.ts";
import { allocationFor, rowNeed } from "../agent/allocation.ts";
import { randomUUID } from "node:crypto";
import { conversations } from "@loxaic/db/schema";
import {
  claimConversation,
  ConversationBusyError,
  isConversationBusy,
  listChildRuns,
  unregisterRun,
} from "../streams/registry.ts";
import { getProviderByKind, getSandboxMode } from "../sandbox/provider.ts";
import { sandboxImage } from "../sandbox/container-provider.ts";
import { loadWorkspace } from "../agent/workspace.ts";
import type { SandboxKind } from "../sandbox/provider.ts";
import { getSandboxSettings, sandboxDisabledReason, sandboxReapAt } from "../settings.ts";

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

  /**
   * The caller's sandbox allocation (#254) and what fills it: every sandbox
   * of theirs that is running or paused, with what each holds while running
   * and whether a run is using it right now (which is what keeps Pause off).
   * Own rows only, and executor sandboxes are left out: they run on the
   * person's own machine and cost this server nothing.
   */
  app.get("/v1/sandboxes/allocation", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const [resolved, used, rows] = await Promise.all([
      allocationFor(userId),
      runningUsage(userId),
      db
        .select({
          id: sandboxes.id,
          conversationId: sandboxes.conversationId,
          provider: sandboxes.provider,
          status: sandboxes.status,
          limits: sandboxes.limits,
          lastUsedAt: sandboxes.lastUsedAt,
          title: conversations.title,
        })
        .from(sandboxes)
        .leftJoin(conversations, eq(conversations.id, sandboxes.conversationId))
        .where(
          and(
            eq(sandboxes.ownerId, userId),
            inArray(sandboxes.status, ["running", "stopped"]),
            ne(sandboxes.provider, "executor"),
          ),
        )
        .orderBy(desc(sandboxes.lastUsedAt), desc(sandboxes.id)),
    ]);
    return {
      allocation: resolved.allocation,
      overridden: resolved.overridden,
      default: getSandboxSettings().allocation,
      used,
      sandboxes: rows.map((row) => {
        const need = rowNeed(row);
        return {
          id: row.id,
          conversation_id: row.conversationId,
          title: row.title,
          provider: row.provider,
          status: row.status,
          memory_mb: need.memoryMb,
          cpus: need.cpus,
          last_used_at: row.lastUsedAt.toISOString(),
          busy: row.conversationId !== null && sandboxBusy(row.conversationId),
        };
      }),
    };
  });

  /**
   * Pauses one of the caller's sandboxes, to make room in their allocation
   * (#254). Files are kept and the next tool call resumes it; open terminals
   * and running processes end, which the client says before asking.
   *
   * Refused while a run uses it — the conversation's own, or a sub-agent's
   * working in its sandbox — and the conversation is claimed for the stop
   * itself, so no run can start halfway through.
   */
  app.post<{ Params: { id: string } }>("/v1/sandboxes/:id/pause", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId), ne(sandboxes.status, "destroyed")),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });
    if (sandbox.provider !== "container") {
      return reply.code(400).send({
        error: "Only a container sandbox can be paused. This one runs directly on its machine, with nothing to pause.",
      });
    }
    if (sandbox.status === "stopped") return { status: "stopped" };
    if (sandbox.conversationId && sandboxBusy(sandbox.conversationId)) {
      return reply.code(409).send({ error: "A run is going in this chat. Stop it first, then pause its sandbox." });
    }
    const claim = sandbox.conversationId
      ? {
          streamId: `pause-${randomUUID()}`,
          conversationId: sandbox.conversationId,
          userId,
          abort: new AbortController(),
          approvals: new Map(),
        }
      : null;
    if (claim) {
      try {
        claimConversation(claim);
      } catch (err) {
        if (err instanceof ConversationBusyError) {
          return reply.code(409).send({ error: "A run is going in this chat. Stop it first, then pause its sandbox." });
        }
        throw err;
      }
    }
    try {
      await pauseSandbox(sandbox);
    } finally {
      if (claim) unregisterRun(claim.streamId);
    }
    return { status: "stopped" };
  });

  app.post("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { repo_url, branch, conversation_id } = request.body as {
      repo_url?: string;
      branch?: string;
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
    // A row that names a conversation is the one the tool loop will adopt for
    // it (sandbox-manager's createEntry), so naming one is a claim on that
    // conversation's execution — owner-only, like every other sandbox route.
    // This field used to be stored unchecked, which let any signed-in user
    // plant a sandbox they owned under someone else's conversation and have
    // that person's agent run inside it. Not-found and not-yours are the same
    // 404, matching the conversation routes.
    if (conversation_id !== undefined) {
      if (typeof conversation_id !== "string" || !(await hasRole(userId, conversation_id, "owner"))) {
        return reply.code(404).send({ error: "Not found" });
      }
      // A conversation that runs in a custom image (#253) must not have a
      // container of Loxaic's own planted for it: the tool loop would adopt
      // it, and run in an image nobody chose.
      const loaded = await loadWorkspace(conversation_id);
      if (loaded && loaded.workspace.kind !== "local" && loaded.workspace.image) {
        return reply.code(409).send({
          error: "This conversation runs in a custom image; its sandbox is created by the agent, not here.",
        });
      }
    }
    // Host mode has real network access unlike a container's NetworkMode:
    // none, so it *could* clone — but the REST surface is broad (any
    // signed-in user, no per-repo scoping), and giving host execution a
    // network-fetching clone step on top is a bigger step than this endpoint
    // should take without a more deliberate design. Rejected outright rather
    // than half-supported.
    if (kind === "host" && repo_url) {
      return reply.code(400).send({ error: "repo_url is not supported with provider=host" });
    }

    // The same per-user allocation the tool loop enforces (#254). This is a
    // second creation path, and an allocation honoured by only one of two is
    // not an allocation: a user could loop this endpoint into unbounded
    // containers — and, because rows made here are never in the in-process
    // map the idle reaper walks, lock *themselves* out of agent sandboxes.
    // A refusal is a 429 through the API's error handler (routes/errors.ts).
    const release = await reserveSandbox(userId, configNeed(kind, {}));

    try {
      const provider = await getProviderByKind(kind);
      // No credential: a token in the body used to be handed to git, and no
      // client sent one. A private repository is cloned through a GitHub
      // workspace, whose clone goes through the egress proxy.
      const handle = await provider.create(userId, { repoUrl: repo_url, branch });

      const [row] = await db
        .insert(sandboxes)
        .values({
          ownerId: userId,
          conversationId: conversation_id ?? null,
          containerId: handle.ref,
          provider: kind,
          image: kind === "container" ? sandboxImage() : "host",
          status: "running",
          repoUrl: repo_url ?? null,
          branch: branch ?? null,
          limits: { memory: 512, cpu: 1, network: networkFor(kind) },
        })
        .returning();

      return row;
    } finally {
      release();
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
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId), ne(sandboxes.status, "destroyed")),
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
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId), ne(sandboxes.status, "destroyed")),
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
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId), ne(sandboxes.status, "destroyed")),
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
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId), ne(sandboxes.status, "destroyed")),
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

/** A run is using this conversation's sandbox: its own, or a sub-agent's,
 * which works in its parent's sandbox. */
function sandboxBusy(conversationId: string): boolean {
  return isConversationBusy(conversationId) || listChildRuns(conversationId).length > 0;
}
