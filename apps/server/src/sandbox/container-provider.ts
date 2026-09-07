/**
 * The server's container sandbox: policy over the mechanics in
 * container-engine.ts.
 *
 * Everything that is a *decision* lives here — which engine to talk to, the
 * cache over that discovery, whether a sandbox may reach the network, and the
 * repo clone — and all of it comes from the deployment's sandbox settings.
 * Everything that is merely *how a container works* lives in the engine
 * module, because the local executor runs that same code on a user's own
 * laptop with entirely different answers to those questions (and must not be
 * able to reach this file's settings, or the database behind them).
 */
import Docker from "dockerode";
import { getSandboxSettings } from "../settings.ts";
import { cloneInto } from "./git.ts";
import {
  candidatesFor,
  createSandboxContainer,
  CONTAINER_WORKDIR,
  discoverFrom,
  ensureImage,
  listSandboxContainersOn,
  makeHandle,
  type Candidate,
} from "./container-engine.ts";
import type { CreateSandboxConfig, SandboxProvider } from "./provider.ts";

// Re-exported so the rest of the tree keeps one import site for "the container
// sandbox", whichever half of the split a given thing now lives in.
export { probeEngines, resetSandboxImageTag, sandboxImage } from "./container-engine.ts";
export type { EngineProbe } from "./container-engine.ts";

/** Which sockets to try, from the deployment's own engine setting. */
function candidates(): Candidate[] {
  const { engine, customSocket } = getSandboxSettings();
  return candidatesFor({ engine, customSocket });
}

/** Test seam: the candidate list is pure (settings + env in, sockets out),
 * and asserting it directly is what keeps the engine picker honest without
 * requiring both engines installed on the machine running the suite. */
export const __candidatesForTest = candidates;

let cached: { docker: Docker; label: string } | null = null;
/** Bumped on every reset so a discovery that started under the old
 * configuration can tell it is stale before publishing its result. */
let engineGeneration = 0;

/**
 * Forgets the discovered engine so the next operation rediscovers from
 * scratch. Required whenever the engine selection changes: `getDocker()`
 * only rediscovers when a ping *fails*, so switching Docker → Podman while
 * Docker is still running would otherwise keep using Docker indefinitely.
 */
export function resetEngineCache(): void {
  cached = null;
  engineGeneration++;
}

async function getDocker(): Promise<{ docker: Docker; label: string } | null> {
  if (cached) {
    try {
      await cached.docker.ping();
      return cached;
    } catch {
      cached = null; // Engine went away — fall through and rediscover.
    }
  }
  const generation = engineGeneration;
  const found = await discoverFrom(candidates());
  // A settings change during that discovery bumps the generation. Publishing
  // a result found under the old configuration would restore precisely the
  // stale engine resetEngineCache() had just cleared, and since the cache is
  // only re-validated by a ping (which the old engine passes), it would stick.
  if (generation === engineGeneration) cached = found;
  return found;
}

/** What was actually tried, for an error/reason message — accurate whether
 * CONTAINER_SOCKET pins a single socket or discovery fanned out over several. */
function describeCandidates(): string {
  const labels = candidates().map((c) => c.label);
  return labels.length === 1 ? labels[0] : `tried: ${labels.join(", ")}`;
}

async function requireDocker(): Promise<{ docker: Docker; label: string }> {
  const found = await getDocker();
  if (!found) {
    throw new Error(
      `no container engine reachable (${describeCandidates()}). ` +
        "Start Docker or Podman, set CONTAINER_SOCKET, or set SANDBOX_MODE=host to run agent commands directly on this machine.",
    );
  }
  return found;
}

/**
 * IDs of every container this provider ever created (all sandboxes carry the
 * loxaic.sandbox label), **running or stopped**. Used by the boot-time orphan
 * sweep. Empty when no engine is reachable — a sweep on a host-mode or
 * engineless machine is a no-op, not an error.
 */
export async function listSandboxContainers(): Promise<string[]> {
  const found = await getDocker();
  if (!found) return [];
  return listSandboxContainersOn(found.docker);
}

let provider: SandboxProvider | null = null;

export function getContainerProvider(): SandboxProvider {
  provider ??= {
    kind: "container",

    async available() {
      const found = await getDocker();
      if (!found) {
        return { ok: false, reason: `no container engine reachable (${describeCandidates()})` };
      }
      return { ok: true };
    },

    async create(userId: string, config: CreateSandboxConfig) {
      const { docker } = await requireDocker();
      await ensureImage(docker);

      // Off by default: everything in here is model-directed, so an outbound
      // network is an exfiltration path. Admins can turn it on (with a
      // warning) when the agent genuinely needs to install dependencies.
      // Fixed at create time — the settings writer stops live sandboxes so a
      // toggle takes effect on the next one.
      const { allowNetwork } = getSandboxSettings();

      // Extra `/etc/hosts` entries, for reaching a service on the host machine
      // from inside a networked sandbox — `host.docker.internal:host-gateway`
      // is what the e2e harness needs on Linux/Podman for its git server
      // (Docker Desktop resolves that name by itself). Operator/test seam, read
      // at call time like every other sandbox env var.
      const extraHosts = (process.env.SANDBOX_EXTRA_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

      const handle = await createSandboxContainer(docker, {
        userId,
        ...(config.limits ? { limits: config.limits } : {}),
        network: allowNetwork,
        extraHosts,
      });

      // A repo clone needs the network, which the sandbox lacks unless an
      // admin enabled it (NetworkMode: "none" by default). We surface the
      // clone failure rather than silently producing an empty repo.
      if (config.repoUrl) {
        try {
          await cloneInto(handle, config, CONTAINER_WORKDIR);
        } catch (err) {
          // destroy, not stop: create() is throwing, so no row will ever
          // claim this container and nothing could resume it.
          await handle.destroy();
          throw err;
        }
      } else {
        // Every sandbox gets the working directory the agent tools default to.
        // Redundant against the current image, which creates it — kept so a
        // container from any image still gets the directory its handle
        // promises, rather than failing on the first exec that defaults to it.
        await handle.exec(["mkdir", "-p", CONTAINER_WORKDIR]);
      }

      return handle;
    },

    async attach(ref) {
      // Always goes through requireDocker() (not a raw `new Docker()`)
      // so a reattach before any prior discovery still honors
      // CONTAINER_SOCKET / the Podman candidates instead of silently
      // falling back to the default socket.
      const { docker } = await requireDocker();
      return makeHandle(docker, ref);
    },
  };
  return provider;
}
