import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "@shannon/db";
import { db } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import { resolvePath } from "../agent/executor.ts";
import { getProviderByKind, getSandboxMode } from "../sandbox/provider.ts";

export function sandboxRoutes(app: FastifyInstance) {
  // Lets a caller find the sandbox backing a conversation — agent sandboxes
  // are created lazily by the tool loop, so their id is otherwise never
  // surfaced to a client. Newest first; own rows only.
  app.get("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id } = request.query as { conversation_id?: string };
    return db.query.sandboxes.findMany({
      where: conversation_id
        ? and(eq(sandboxes.ownerId, userId), eq(sandboxes.conversationId, conversation_id))
        : eq(sandboxes.ownerId, userId),
      orderBy: desc(sandboxes.createdAt),
    });
  });

  app.post("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { repo_url, branch, token, conversation_id, provider: providerOverride } = request.body as {
      repo_url?: string;
      branch?: string;
      token?: string;
      conversation_id?: string;
      provider?: string;
    };
    // An explicit `provider` in the body always wins; otherwise this follows
    // the server's configured SANDBOX_MODE rather than hardcoding
    // "container" — a REST caller that doesn't ask for a specific provider
    // should get whatever the deployment is actually set up to use.
    const globalMode = getSandboxMode();
    if (providerOverride !== "host" && providerOverride !== "container" && globalMode === "off") {
      return reply.code(400).send({ error: "sandboxes are disabled (SANDBOX_MODE=off)" });
    }
    const kind: "container" | "host" =
      providerOverride === "host" || providerOverride === "container"
        ? providerOverride
        : globalMode === "host" ? "host" : "container";
    // Host mode has real network access unlike a container's NetworkMode:
    // none, so it *could* clone — but the REST surface is unauthenticated-ish
    // (any signed-in user, no per-repo scoping), and giving arbitrary host
    // execution a network-fetching clone step on top is a bigger step than
    // this endpoint should take without a more deliberate design. Rejected
    // outright for now rather than half-supported.
    if (kind === "host" && repo_url) {
      return reply.code(400).send({ error: "repo_url is not supported with provider=host" });
    }

    const provider = await getProviderByKind(kind);
    const handle = await provider.create(userId, { repoUrl: repo_url, branch, token });

    const [row] = await db
      .insert(sandboxes)
      .values({
        ownerId: userId,
        conversationId: conversation_id ?? null,
        containerId: handle.ref,
        provider: kind,
        image: kind === "container" ? (process.env.SANDBOX_IMAGE ?? "shannon-sandbox") : "host",
        status: "running",
        repoUrl: repo_url ?? null,
        branch: branch ?? null,
        limits: { memory: 512, cpu: 1 },
      })
      .returning();

    return row;
  });

  app.delete<{ Params: { id: string } }>("/v1/sandboxes/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
    await handle.stop();
    await db
      .update(sandboxes)
      .set({ status: "stopped", stoppedAt: new Date() })
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
    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
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
    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
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
    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
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
    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
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
