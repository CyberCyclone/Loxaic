/**
 * Starts the egress proxy (proxy.ts) beside the API, and records where
 * sandboxes reach it (env.ts).
 *
 * Where it listens is the whole security story of the address: a sandbox
 * must reach it, and nothing else should. It always listens on loopback,
 * which is what a host-mode sandbox uses and what Docker Desktop, OrbStack and
 * Colima forward `host.docker.internal` to. A Linux engine has no such
 * forwarding: a container reaches the host at the Docker bridge's gateway, so
 * on Linux it also listens there, and containers are given that address
 * directly — no `/etc/hosts` entry, so a container paused before this server
 * started still finds it when it resumes. Never a public address: the
 * credential a sandbox holds is not a secret from whoever runs code in it.
 *
 * EGRESS_PROXY_BIND (comma-separated) replaces the addresses, EGRESS_PROXY_PORT
 * pins the port (ephemeral by default — the port is given to each command,
 * and a fixed one would collide between servers on one machine), and
 * EGRESS_PROXY_HOST is what containers are told. A proxy that cannot start
 * leaves GitHub unreachable from sandboxes, and says so; the server runs on.
 */
import { bridgeGateway } from "../sandbox/container-provider.ts";
import { startEgressProxy, type EgressProxy } from "./proxy.ts";
import { setRunningEgressProxy } from "./env.ts";

export async function bootEgressProxy(log: (message: string) => void): Promise<EgressProxy[]> {
  const pinned = process.env.EGRESS_PROXY_BIND?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const gateway = pinned.length === 0 && process.platform === "linux" ? await bridgeGateway().catch(() => null) : null;
  const binds = pinned.length > 0 ? pinned : ["127.0.0.1", ...(gateway ? [gateway] : [])];
  const wanted = process.env.EGRESS_PROXY_PORT ? Number(process.env.EGRESS_PROXY_PORT) : 0;
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65_535) {
    throw new Error(`EGRESS_PROXY_PORT is not a port: ${String(process.env.EGRESS_PROXY_PORT)}`);
  }

  const started: EgressProxy[] = [];
  try {
    for (const host of binds) {
      // Every address on one port, so a sandbox needs only one.
      started.push(await startEgressProxy({ port: started[0]?.port ?? wanted, host }));
    }
  } catch (err) {
    await Promise.all(started.map((p) => p.close()));
    throw err;
  }
  const first = started.at(0);
  if (!first) throw new Error("EGRESS_PROXY_BIND names no address");
  setRunningEgressProxy({
    port: first.port,
    bind: first.host,
    ...(gateway ? { containerHost: gateway } : {}),
  });
  log(`GitHub egress proxy listening on ${binds.map((h) => `${h}:${String(first.port)}`).join(", ")}`);
  return started;
}
