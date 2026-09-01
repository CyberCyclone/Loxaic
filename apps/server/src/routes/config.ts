import type { FastifyInstance } from "fastify";
import { getSandboxStatus } from "../sandbox/status.ts";
import { ensureCluster, listHosts } from "../cluster.ts";

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

  /**
   * Cluster identity + its hosts. Unauthenticated on purpose: a client
   * deciding whether to join a host has to be able to ask what it is before
   * it has an account there, which is exactly the onboarding "probe this
   * URL" step. It exposes only what a join screen needs — no settings, no
   * user data, no socket paths.
   */
  app.get("/v1/cluster", async () => {
    const cluster = await ensureCluster();
    return { cluster, hosts: await listHosts() };
  });
}
