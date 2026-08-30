import type { FastifyInstance } from "fastify";
import { getSandboxMode, getSandboxProvider } from "../sandbox/provider.ts";
import { getSandboxSettings } from "../settings.ts";

/**
 * Unauthenticated, no-secrets, client-facing config — whether agent sandboxes
 * are usable, so a UI can show the reason inline instead of a client only
 * discovering it when a tool call fails mid-run.
 *
 * Deliberately minimal. Which engines are installed, the socket paths, and
 * which fields the environment pins are all admin concerns and live behind
 * `GET /v1/admin/settings/sandbox` instead.
 */
export function configRoutes(app: FastifyInstance) {
  app.get("/v1/config", async () => {
    const mode = getSandboxMode();
    const { allowNetwork } = getSandboxSettings();
    if (mode === "off") {
      return {
        sandbox: { mode, available: false, allowNetwork, reason: "sandboxes are disabled (SANDBOX_MODE=off)" },
      };
    }
    const provider = await getSandboxProvider();
    const status = await provider?.available() ?? { ok: false, reason: "no sandbox provider" };
    return {
      sandbox: {
        mode,
        available: status.ok,
        // Host sandboxes run on the host's own network regardless of the
        // container-only setting; reporting the raw flag there would be a lie.
        allowNetwork: mode === "host" ? true : allowNetwork,
        ...(status.reason ? { reason: status.reason } : {}),
      },
    };
  });
}
