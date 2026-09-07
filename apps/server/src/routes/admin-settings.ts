import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/middleware";
import { getSandboxStatus } from "../sandbox/status.ts";
import { probeEngines } from "../sandbox/container-provider.ts";
import {
  getInferenceSettings,
  getSandboxSettings,
  SettingsError,
  updateInferenceSettings,
  updateSandboxSettings,
} from "../settings.ts";
import { resolveMaxConcurrent } from "../inference/scheduler.ts";

/**
 * Server-level settings, admin-only.
 *
 * Explicitly does NOT inherit /v1/config's unauthenticated posture: host mode
 * runs model-directed commands on the machine with no isolation, and the
 * network toggle opens an exfiltration path — neither should be reachable by
 * every signed-in user on a multi-user install.
 */
export function adminSettingsRoutes(app: FastifyInstance) {
  app.get("/v1/admin/settings/sandbox", async (request, reply) => {
    await requireAdmin(request, reply);
    return sandboxView();
  });

  app.get("/v1/admin/settings/inference", async (request, reply) => {
    await requireAdmin(request, reply);
    return inferenceView();
  });

  app.patch("/v1/admin/settings/inference", async (request, reply) => {
    await requireAdmin(request, reply);
    try {
      await updateInferenceSettings(request.body ?? {});
    } catch (err) {
      if (err instanceof SettingsError) {
        return reply
          .code(err.code === "envOverride" ? 409 : 400)
          .send({ error: err.message, ...(err.code === "envOverride" ? { envOverride: true } : {}) });
      }
      throw err;
    }
    return inferenceView();
  });

  app.patch("/v1/admin/settings/sandbox", async (request, reply) => {
    await requireAdmin(request, reply);
    try {
      // Untrusted JSON: updateSandboxSettings takes `unknown` and narrows it.
      await updateSandboxSettings(request.body ?? {});
    } catch (err) {
      if (err instanceof SettingsError) {
        // 409 for an env pin: the request is well-formed, it conflicts with
        // how this deployment is configured, and the GUI renders that field
        // read-only rather than treating it as user error.
        return reply
          .code(err.code === "envOverride" ? 409 : 400)
          .send({ error: err.message, ...(err.code === "envOverride" ? { envOverride: true } : {}) });
      }
      throw err;
    }
    return sandboxView();
  });
}

/**
 * The run-queue setting plus the number actually in force.
 *
 * Both, because they routinely differ and the difference is the whole point:
 * the stored value is usually null ("follow the backend"), and what an admin
 * needs to see is the number that null resolved to — 4 because llama.cpp was
 * started with `--parallel 4`, or 1 because LM Studio says nothing.
 */
async function inferenceView() {
  const settings = getInferenceSettings();
  return { ...settings, effectiveMaxConcurrentRuns: await resolveMaxConcurrent() };
}

/** Settings plus the live facts a GUI needs to render them: which engines are
 * actually installed (so unavailable ones can be greyed out) and whether the
 * configured provider works at all. */
async function sandboxView() {
  const settings = getSandboxSettings();
  // Status comes from the same helper the public /v1/config uses, so the two
  // can't drift — they previously disagreed about allowNetwork in host mode.
  // Engines are probed concurrently with it: both hit sockets that may be
  // down, and serializing them stacked their timeouts on every screen load.
  // Probing is container-only — noise on a host-mode machine with no engine.
  const [status, engines] = await Promise.all([
    getSandboxStatus(),
    settings.mode === "container" ? probeEngines() : Promise.resolve([]),
  ]);
  return {
    ...settings,
    // The effective value, matching /v1/config — host is always networked.
    allowNetwork: status.allowNetwork,
    available: status.available,
    ...(status.reason ? { reason: status.reason } : {}),
    engines,
  };
}
