import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin } from "../auth/middleware";
import { kickScheduler } from "../inference/scheduler.ts";
import { invalidateBackendModels, probeProviderModels } from "../inference/models.ts";
import { ProviderKeyUnreadableError } from "../inference/provider-secrets.ts";
import {
  createProvider,
  defaultProvider,
  deleteProvider,
  getProviderRow,
  listProviderRows,
  ProviderInputError,
  recordProviderCheck,
  toApi,
  updateProvider,
} from "../inference/providers.ts";

/**
 * The LLM backends this deployment can reach, admin-only.
 *
 * Admin-only for the same reason the sandbox settings are: one key pays for
 * every user's requests, and its base URL is deployment configuration of
 * exactly the kind `INFERENCE_BASE_URL` already is. Hiding the screen from a
 * non-admin is presentation; `requireAdmin` on every route here is the
 * boundary.
 *
 * No route ever returns a stored API key — not even to the admin who typed it.
 * `hasApiKey` is the whole of what a client is told, matching how MCP secrets
 * are named but never shown.
 */
export function adminProviderRoutes(app: FastifyInstance) {
  app.get("/v1/admin/providers", async (request, reply) => {
    await requireAdmin(request, reply);
    const rows = await listProviderRows();
    return {
      // The built-in backend, described but not editable: an admin needs to
      // see what it is before deciding whether to add anything, and "set by an
      // environment variable" is the answer to why they cannot change it here.
      builtin: {
        id: defaultProvider().id,
        name: defaultProvider().name,
        baseUrl: defaultProvider().apiBase,
        envVar: "INFERENCE_BASE_URL",
      },
      providers: rows.map(toApi),
    };
  });

  app.post("/v1/admin/providers", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    try {
      // Untrusted JSON: createProvider takes `unknown` fields and narrows them.
      const row = await createProvider(request.body ?? {}, userId);
      afterWrite();
      return await reply.code(201).send(toApi(row));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/v1/admin/providers/:id", async (request, reply) => {
    await requireAdmin(request, reply);
    const { id } = request.params as { id: string };
    try {
      const row = await updateProvider(id, request.body ?? {});
      if (!row) return await reply.code(404).send({ error: "Provider not found" });
      afterWrite();
      return toApi(row);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/v1/admin/providers/:id", async (request, reply) => {
    await requireAdmin(request, reply);
    const { id } = request.params as { id: string };
    const existed = await deleteProvider(id);
    if (!existed) return reply.code(404).send({ error: "Provider not found" });
    afterWrite();
    return { ok: true };
  });

  /**
   * Ask the provider what it can do, right now.
   *
   * Always really tries — no cache — because pressing Test after fixing a key
   * must not be answered by the failure that prompted the fix. The outcome is
   * recorded on the row so the list can show which provider is broken without
   * every client re-probing it.
   */
  app.post("/v1/admin/providers/:id/test", async (request, reply) => {
    await requireAdmin(request, reply);
    const { id } = request.params as { id: string };
    const row = await getProviderRow(id);
    if (!row) return reply.code(404).send({ error: "Provider not found" });
    try {
      const models = await probeProviderModels(id);
      await recordProviderCheck(id, null);
      afterWrite();
      return { ok: true, models: models.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordProviderCheck(id, message);
      afterWrite();
      // 200 with ok:false, not a 5xx: the request was well-formed and the
      // answer ("it cannot be reached, here is why") is the point of the call.
      return { ok: false, error: message };
    }
  });

  /** Everything the provider lists, before its own allowlist is applied —
   * otherwise the allowlist editor could only ever show what is already
   * allowed, and nothing could be added back. */
  app.get("/v1/admin/providers/:id/models", async (request, reply) => {
    await requireAdmin(request, reply);
    const { id } = request.params as { id: string };
    const row = await getProviderRow(id);
    if (!row) return reply.code(404).send({ error: "Provider not found" });
    try {
      const models = await probeProviderModels(id);
      return { models: models.map((m) => ({ id: m.upstream_id, display_name: m.display_name })) };
    } catch (err) {
      return reply.code(200).send({ models: [], error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Every write changes what the model list and the queue should be doing: a
 * rename restamps `provider_name` on every entry, a concurrency change resizes
 * a queue that only re-reads its limit when a slot frees, and a delete has to
 * stop being offered. */
function afterWrite(): void {
  invalidateBackendModels();
  kickScheduler();
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ProviderInputError || err instanceof ProviderKeyUnreadableError) {
    return reply.code(400).send({ error: err.message });
  }
  throw err;
}
