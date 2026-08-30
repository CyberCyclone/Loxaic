import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/middleware";
import { getSandboxProvider } from "../sandbox/provider.ts";
import { probeEngines } from "../sandbox/container-provider.ts";
import { getSandboxSettings, SettingsError, updateSandboxSettings } from "../settings.ts";

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

/** Settings plus the live facts a GUI needs to render them: which engines are
 * actually installed (so unavailable ones can be greyed out) and whether the
 * configured provider works at all. */
async function sandboxView() {
  const settings = getSandboxSettings();
  const provider = await getSandboxProvider();
  const status = settings.mode === "off"
    ? { ok: false, reason: "sandboxes are disabled (SANDBOX_MODE=off)" }
    : await provider?.available() ?? { ok: false, reason: "no sandbox provider" };
  // Only meaningful for container mode; probing engines in host mode would be
  // noise on a machine that deliberately has none.
  const engines = settings.mode === "container" ? await probeEngines() : [];
  return {
    ...settings,
    available: status.ok,
    ...(status.reason ? { reason: status.reason } : {}),
    engines,
  };
}
