/**
 * One Docker network per browser session (#281).
 *
 * Why per-session rather than one shared browser network: it turns the issue's
 * "it should be impossible for a user to access someone else's Chromium session"
 * into a property of the network topology. A container on
 * `loxaic-browser-aaa` has no route to a container on `loxaic-browser-bbb`, and
 * no code of ours is in the way of that statement — no check to get wrong, no
 * label to mis-parse, no host header to spoof. It also gives the proxy a
 * per-session address to bind (see `gateway` below and `proxy.ts`), so a
 * different session cannot even reach the *listener*, let alone the guard.
 *
 * `Internal: true` is the other half. It removes the bridge's masquerade rule and
 * the outbound forwarding path, so a container on this network has no route to
 * the internet: what it can address is another container on the same network and
 * the bridge gateway, and the gateway is a *local* address of this host —
 * delivered to the proxy without traversing the FORWARD chain, which is why an
 * internal network still reaches it. Every byte that leaves the machine
 * therefore arrives at a socket that decides, per request, whether it may.
 *
 * (The reachability of an internal network's gateway from its own containers is
 * asserted by an e2e spec rather than assumed: it is engine behaviour, and this
 * repo has had engine differences between Docker, Podman and OrbStack before.)
 */
import Docker from "dockerode";
import { createHash } from "node:crypto";
import { BROWSER_LABEL } from "./container.ts";

/** Label on the network itself, so the boot sweep can claim or destroy it
 * without parsing names. */
export const BROWSER_NETWORK_LABEL = "loxaic.browser.network";

/** The network name for a conversation. Deterministic (so a crash between
 * creating the network and creating the container is findable by the sweep) and
 * derived from the id rather than embedding it, so a container name on the
 * engine never carries a raw database id. */
export function browserNetworkName(conversationId: string): string {
  return `loxaic-browser-${createHash("sha256").update(conversationId).digest("hex").slice(0, 12)}`;
}

export interface BrowserNetwork {
  name: string;
  /** The bridge gateway: the address a container on this network reaches the
   * host on, and therefore the address the proxy prefers to be bound to for
   * this session. Read back from the engine rather than assumed `x.y.z.1`. */
  gateway: string;
  /** The network's CIDR (`172.x.y.0/24`-shaped). Used for the proxy's
   * fallback mode, where the gateway address is not bindable on the host and
   * a request's *source* address has to identify the session instead
   * (`proxy.ts`). Null when the engine reports no subnet, which makes browsing
   * unavailable rather than unpoliced. */
  subnet: string | null;
}

/**
 * Creates the session's network.
 *
 * No subnet is requested: Docker picks one that does not collide, and the
 * gateway is read back from the inspect. Assuming `…​.1` would be a second
 * source of truth about where the proxy lives, on an engine (rootless Podman
 * in particular) that hands out addresses differently.
 */
export async function createBrowserNetwork(
  docker: Docker,
  conversationId: string,
): Promise<BrowserNetwork> {
  const name = browserNetworkName(conversationId);
  const existing = await docker.getNetwork(name).inspect().catch(() => null);
  const created = existing
    ? docker.getNetwork(name)
    : await docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Labels: { [BROWSER_NETWORK_LABEL]: "1", [BROWSER_LABEL]: "1" },
      });
  const info = (await created.inspect()) as {
    IPAM?: { Config?: { Gateway?: string; Subnet?: string }[] };
  };
  const config = info.IPAM?.Config?.find((c) => c.Gateway);
  if (!config?.Gateway) throw new Error(`browser network ${name} has no gateway address`);
  return { name, gateway: config.Gateway, subnet: config.Subnet ?? null };
}

/** Removes the session's network. Idempotent: a network the engine already
 * removed (or that was never created) is the success case. */
export async function destroyBrowserNetwork(docker: Docker, name: string): Promise<void> {
  try {
    await docker.getNetwork(name).remove();
  } catch (err) {
    const code = (err as { statusCode?: number } | null)?.statusCode;
    if (code === 404) return;
    // 403 "network has active endpoints" is the one worth surfacing: it means a
    // container is still joined, and the caller has to destroy that first, or
    // the network accumulates.
    throw err;
  }
}

export interface BrowserNetworkListing {
  name: string;
  labels: Record<string, string>;
}

/** Networks this feature created. A network with no container in it is a leak:
 * created, then abandoned by a crash before the container existed, or left by a
 * destroy that failed partway. Nothing else reclaims them. */
export async function listBrowserNetworksOn(docker: Docker): Promise<BrowserNetworkListing[]> {
  const listed = (await docker.listNetworks({
    filters: { label: [BROWSER_NETWORK_LABEL] },
  })) as { Name: string; Labels?: Record<string, string> }[];
  return listed
    .filter((n) => n.Labels?.[BROWSER_NETWORK_LABEL] === "1")
    .map((n) => ({ name: n.Name, labels: n.Labels ?? {} }));
}

/** Containers currently joined to a network — the emptiness check a network
 * removal wants, and the proof (in tests) that a session's network holds only
 * its own browser plus, on the agent surface, its own workspace sandbox. */
export async function networkContainers(docker: Docker, name: string): Promise<string[]> {
  const info = (await docker.getNetwork(name).inspect().catch(() => null)) as {
    Containers?: Record<string, { Name?: string }>;
  } | null;
  return Object.values(info?.Containers ?? {}).map((c) => c.Name ?? "");
}
