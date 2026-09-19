import type { FastifyInstance } from "fastify";
import { getSandboxStatus } from "../sandbox/status.ts";
import { getCluster, listHosts } from "../cluster.ts";
import { signUpClosedReason } from "../auth/index.ts";
import { resolveSessionFromToken } from "../auth/middleware.ts";
import { serverVersion } from "../version.ts";
import { getConversationSettings } from "../settings.ts";

/**
 * Unauthenticated, no-secrets, client-facing config — whether agent sandboxes
 * are usable, so a UI can show the reason inline instead of a client only
 * discovering it when a tool call fails mid-run.
 *
 * Deliberately minimal. Which engines are installed, the socket paths, and
 * which fields the environment pins are all admin concerns and live behind
 * `GET /v1/admin/settings/sandbox` instead.
 *
 * `version` is included only for an authenticated caller (see the handler),
 * and is null on anything that never set `LOXAIC_VERSION`/
 * `npm_package_version` (a bare `node dist/index.js`, a hand-rolled Docker
 * image, an unstamped desktop build), which the client renders as "—".
 */
export function configRoutes(app: FastifyInstance) {
  app.get("/v1/config", async (request) => {
    // `signUpOpen` lets a sign-in screen stop offering "Create one" when the
    // server would refuse it; the refusal itself is enforced in auth.
    const retention = getConversationSettings();
    const body: {
      sandbox: unknown;
      signUpOpen: boolean;
      deletedChatRetentionDays: number | null;
      version?: string | null;
    } = {
      sandbox: await getSandboxStatus(),
      signUpOpen: signUpClosedReason() === null,
      // Null means deleting erases; a number means this deployment keeps
      // deleted chats that long for an admin to audit. The confirm dialog says
      // which, in those words, *before* the user commits to it — a delete that
      // silently leaves a readable copy behind, or silently erases one the user
      // thought was recoverable, is the same failure in two directions. Not
      // gated on authentication like `version` is: it describes a policy the
      // user is about to be subject to, not this build's attack surface.
      deletedChatRetentionDays: retention.keepDeleted ? retention.keepDeletedDays : null,
    };
    // `version` only for a signed-in caller. Its consumers (the settings
    // row's server-vs-app skew line) are all behind the auth gate, so this
    // costs the feature nothing — while an exact build number readable by
    // anyone who can reach the port is the standard precondition for "which
    // known-vulnerable release is this?", and with Funnel that port can be
    // on the public internet. /v1/cluster strips the same field for the same
    // reason; the two agree now.
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
    if (match && (await resolveSessionFromToken(match[1]))) body.version = serverVersion();
    return body;
  });

  /**
   * Cluster identity + its hosts. Unauthenticated on purpose: a client
   * deciding whether to join a host has to be able to ask what it is before
   * it has an account there, which is exactly the onboarding "probe this
   * URL" step. It exposes only what a join screen needs — no settings, no
   * user data, no socket paths.
   */
  app.get("/v1/cluster", async (_request, reply) => {
    // Read-only: identity is minted at boot, so a request never needs to
    // create it — and an unauthenticated path should not be able to drive a
    // write at all. Absent identity means the server hasn't finished booting.
    const cluster = await getCluster();
    if (!cluster) {
      reply.code(503);
      return { error: "cluster identity not ready" };
    }
    const hosts = await listHosts();
    // Projected, not passed through. HostView also carries inferenceBaseUrl
    // (an internal backend address), advertiseUrl for every machine, and a
    // version fingerprint — internal topology, none of which a join screen
    // reads. It consumes exactly {id, name, online}. (The version of *this*
    // host is available from /v1/config, to a signed-in caller only — the
    // same rule as here.)
    return {
      cluster: { id: cluster.id, name: cluster.name },
      // `self` lets a client name the host it is talking to ("Remote — the
      // GPU box") without inferring it from the URL it happened to connect by.
      hosts: hosts.map((h) => ({ id: h.id, name: h.name, online: h.online, self: h.self })),
    };
  });
}
