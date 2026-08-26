import type { FastifyInstance } from "fastify";
import { and, eq } from "@shannon/db";
import { db } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import {
  createSandbox,
  stopSandbox,
  execInContainer,
  getSandboxFileTree,
  readSandboxFile,
  writeSandboxFile,
  getContainer,
} from "../sandbox/orchestrator";

export function sandboxRoutes(app: FastifyInstance) {
  app.post("/v1/sandboxes", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { repo_url, branch, token, conversation_id } = request.body as {
      repo_url?: string;
      branch?: string;
      token?: string;
      conversation_id?: string;
    };

    const info = await createSandbox(userId, {
      repoUrl: repo_url,
      branch,
      token,
    });

    const [row] = await db
      .insert(sandboxes)
      .values({
        ownerId: userId,
        conversationId: conversation_id ?? null,
        containerId: info.containerId,
        image: "shannon-sandbox",
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

    await stopSandbox(sandbox.containerId);
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
    const container = getContainer(sandbox.containerId);
    const result = await execInContainer(container, ["bash", "-c", command], { workdir });
    return result;
  });

  app.get<{ Params: { id: string } }>("/v1/sandboxes/:id/files", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path } = request.query as { path?: string };
    const container = getContainer(sandbox.containerId);
    return getSandboxFileTree(container, path ?? "/home/shannon/repo");
  });

  app.get<{ Params: { id: string } }>("/v1/sandboxes/:id/files/read", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path } = request.query as { path: string };
    if (!path) return reply.code(400).send({ error: "path required" });

    const container = getContainer(sandbox.containerId);
    const content = await readSandboxFile(container, path);
    return { content };
  });

  app.post<{ Params: { id: string } }>("/v1/sandboxes/:id/files/write", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, request.params.id), eq(sandboxes.ownerId, userId)),
    });
    if (!sandbox) return reply.code(404).send({ error: "Not found" });

    const { path, content } = request.body as { path: string; content: string };
    const container = getContainer(sandbox.containerId);
    await writeSandboxFile(container, path, content);
    return { ok: true };
  });
}