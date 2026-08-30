import type { FastifyInstance } from "fastify";
import { getSandboxStatus } from "../sandbox/status.ts";

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
    return { sandbox: await getSandboxStatus() };
  });
}
