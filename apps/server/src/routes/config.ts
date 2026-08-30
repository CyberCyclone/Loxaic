import type { FastifyInstance } from "fastify";
import { getSandboxMode, getSandboxProvider } from "../sandbox/provider.ts";

/**
 * Unauthenticated, no-secrets, client-facing config — right now just whether
 * agent sandboxes are usable, so a UI can show the reason inline instead of
 * a client only discovering it when a tool call fails mid-run.
 */
export function configRoutes(app: FastifyInstance) {
  app.get("/v1/config", async () => {
    const mode = getSandboxMode();
    if (mode === "off") {
      return { sandbox: { mode, available: false, reason: "sandboxes are disabled (SANDBOX_MODE=off)" } };
    }
    const provider = await getSandboxProvider();
    const status = await provider?.available() ?? { ok: false, reason: "no sandbox provider" };
    return { sandbox: { mode, available: status.ok, ...(status.reason ? { reason: status.reason } : {}) } };
  });
}
