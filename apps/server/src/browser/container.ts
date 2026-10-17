/**
 * The browsing container and its network (#281).
 *
 * Deliberately its own creation path rather than `createSandboxContainer()`.
 * A browser is not a sandbox: it is never paused, never resumed, never mounted,
 * and must never be visible to the sandbox orphan sweep. `createSandboxContainer`
 * stamps `loxaic.sandbox` on everything it makes, and that label is exactly what
 * the sandbox sweep selects on — so a browser created there would be swept as a
 * stray sandbox, and (worse) a bug in one sweep would start destroying the other
 * feature's containers. The security flags that genuinely are the same are
 * repeated here and named as such.
 *
 * What a browser session gets:
 *
 * - **its own Docker network**, so "conversation A cannot reach conversation
 *   B's browser" is a property of the network topology rather than a check in
 *   our code (see `network.ts`);
 * - **a tmpfs profile**, so cookies, cache, history, service workers and
 *   localStorage die with the container and cannot be written to disk at all;
 * - **no bind mounts**, so there is nothing on the host for a page exploit to
 *   reach; and
 * - CDP published on **127.0.0.1 only**, which is the one port and the reason
 *   it is shaped that way — see `createBrowserContainer`.
 */
import Docker from "dockerode";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "tar-fs";
import { CDP_PORT } from "./launch.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The Chromium minor this image is built for. The driver in
 * apps/server/package.json must be the same minor: `connectOverCDP` against a
 * browser from another minor fails in ways that look like a broken session.
 * Kept beside the digest in the Dockerfile's comment. */
export const PLAYWRIGHT_VERSION = "1.64.1";

/** Labels on a browser container. `conversation` is the browser session's key
 * and is only ever a real conversation id this server owns; the sweep and the
 * admin status read these, nothing model-facing does. */
export const BROWSER_LABEL = "loxaic.browser";
export const BROWSER_USER_LABEL = "loxaic.user";
export const BROWSER_CONVERSATION_LABEL = "loxaic.browser.conversation";

const BROWSER_LIMITS = {
  // Chromium is a renderer, not a shell: one process per site instance, plus
  // GPU and utility processes even headless. 512 MB (the sandbox default) OOMs
  // on an ordinary news site; 2 GB is what Playwright's own docs suggest for
  // comfortable headless runs, and it is per *session*, capped by
  // BROWSER_MAX_SESSIONS_PER_USER.
  Memory: 2 * 1024 * 1024 * 1024,
  NanoCpus: 2_000_000_000,
  // Chromium legitimately forks a dozen processes; a tight PidsLimit shows up
  // as random tab crashes rather than as anything naming the limit.
  PidsLimit: 300,
};

let imageTag: string | null = null;

/**
 * The browsing image, tagged with a hash of the Dockerfile that defines it —
 * the same content-derived-tag reasoning as `sandboxImage()`: `ensureBrowserImage`
 * builds only when the image is *absent*, so a fixed tag would mean a changed
 * Dockerfile never reaches a deployment that built once, and the failure would
 * surface much later as "No such image" from `createContainer`.
 */
export function browserImage(): string {
  if (process.env.LOXAIC_BROWSER_IMAGE) return process.env.LOXAIC_BROWSER_IMAGE;
  if (imageTag) return imageTag;
  let digest = "base";
  try {
    const hash = createHash("sha256");
    hash.update(readFileSync(path.join(buildContextDir(), "browser.Dockerfile")));
    digest = hash.digest("hex").slice(0, 12);
  } catch {
    // No build context (a packaged desktop build without the repo): a stable
    // fallback beats throwing at import time on a machine that will never
    // browse. The clear failure comes from ensureBrowserImage instead.
  }
  imageTag = `loxaic-browser:${digest}`;
  return imageTag;
}

/** Test seam, as `resetSandboxImageTag()`. */
export function resetBrowserImageTag(): void {
  imageTag = null;
}

function buildContextDir(): string {
  if (process.env.SANDBOX_BUILD_CONTEXT) return process.env.SANDBOX_BUILD_CONTEXT;
  return path.resolve(__dirname, "../../../../infra/docker");
}

/** Builds the browsing image when the engine does not have it. The build
 * context is the whole `infra/docker/` directory (as for the sandbox image,
 * which COPYs from `sandbox/`); `dockerfile:` names ours. */
export async function ensureBrowserImage(docker: Docker): Promise<void> {
  const image = browserImage();
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Not present — build below.
  }
  const contextDir = buildContextDir();
  if (!existsSync(path.join(contextDir, "browser.Dockerfile"))) {
    throw new Error(`browsing image "${image}" not found and no Dockerfile at ${contextDir} to build it`);
  }
  const buildStream = await docker.buildImage(pack(contextDir), {
    t: image,
    dockerfile: "browser.Dockerfile",
  });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err: Error | null, output: { error?: string; errorDetail?: { message?: string } }[]) => {
      if (err) {
        reject(err);
        return;
      }
      // A failed build step is not an `err` — see the same note in
      // container-engine.ts's ensureImage. Without this a failed build looks
      // like success and the real failure arrives later as "No such image".
      const failure = output.find((line) => line.error ?? line.errorDetail?.message);
      if (failure) {
        reject(new Error(`browsing image build failed: ${failure.errorDetail?.message ?? failure.error ?? "unknown error"}`));
        return;
      }
      resolve();
    });
  });
}

export interface BrowserContainerSpec {
  /** Recorded as `loxaic.user`: the conversation's **owner**, never whoever
   * triggered the call — the same identity the sandbox row uses, so a sweep
   * scoped to one user selects by one identity. */
  userId: string;
  conversationId: string;
  /** The session's own network, created by `network.ts` before this call. */
  network: string;
}

export interface BrowserContainer {
  id: string;
  /** The container's address on its session network — how the *workspace
   * sandbox* reaches CDP on the agent surface. */
  ip: string;
  /** CDP on the host's loopback (`127.0.0.1:<mapped>`), which is how the server
   * connects. Loopback rather than the container address because on Docker
   * Desktop (macOS, Windows) the engine runs in a VM and container addresses are
   * not reachable from the host at all; the published port is the one path that
   * works on every engine. It is bound to 127.0.0.1 so nothing that is not this
   * machine can reach it, and a container cannot either: a port published on the
   * host's loopback is not routable from a bridge network. */
  hostCdpPort: number;
}

/**
 * Creates and starts one browser container, joined to its session's network.
 *
 * The flags below are the sandbox ones (`Init`, `CapDrop: ALL`,
 * `no-new-privileges`, non-root from the image) plus the browser-specific ones,
 * and two things about them are load-bearing: **no `Binds`** (nothing on the
 * host is visible to a process rendering hostile pages), and the **`127.0.0.1`
 * in `PortBindings`** — the one published port is CDP, bound so that only this
 * machine can reach it, and never `0.0.0.0`, which would put the full control
 * surface of a logged-in browser on the network.
 */
export async function createBrowserContainer(docker: Docker, spec: BrowserContainerSpec): Promise<BrowserContainer> {
  const container = await docker.createContainer({
    Image: browserImage(),
    Cmd: ["tail", "-f", "/dev/null"],
    HostConfig: {
      Memory: BROWSER_LIMITS.Memory,
      NanoCpus: BROWSER_LIMITS.NanoCpus,
      PidsLimit: BROWSER_LIMITS.PidsLimit,
      // **True**, unlike a sandbox. A browser's filesystem has nothing worth
      // keeping — the profile is a tmpfs precisely so there is nothing to keep —
      // so "stop" is "destroy", and AutoRemove is what stops every teardown,
      // crash and host reboot from leaving a stopped container behind forever.
      AutoRemove: true,
      Init: true,
      NetworkMode: spec.network,
      // The profile and scratch space are memory-backed: a page's cookies,
      // cache, history, service-worker state and downloaded bytes exist only as
      // long as the container, and a destroy cannot leave them on disk for the
      // next session to find. `size=` caps them so a page filling its own cache
      // cannot push the container's memory limit instead.
      Tmpfs: {
        "/home/loxaic/profile": "rw,size=512m,mode=1777",
        "/tmp": "rw,size=256m,mode=1777",
      },
      // See BrowserContainer.hostCdpPort: loopback-only, ephemeral host port.
      PortBindings: {
        [`${CDP_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
    Labels: {
      [BROWSER_LABEL]: uuid4(),
      [BROWSER_USER_LABEL]: spec.userId,
      [BROWSER_CONVERSATION_LABEL]: spec.conversationId,
    },
  });
  await container.start();
  const inspected = (await container.inspect()) as {
    NetworkSettings?: {
      Networks?: Record<string, { IPAddress?: string }>;
      Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    };
  };
  const ip = inspected.NetworkSettings?.Networks?.[spec.network]?.IPAddress;
  if (!ip) throw new Error("browser container started without an address on its session network");
  const binding = inspected.NetworkSettings?.Ports?.[`${CDP_PORT}/tcp`]?.[0];
  if (!binding?.HostPort) throw new Error("browser container started without a loopback CDP port");
  // Refuse to connect through a binding that is not loopback: a daemon that
  // ignored HostIp would mean any host on the network could drive this browser.
  if (binding.HostIp !== "127.0.0.1" && binding.HostIp !== "::1") {
    throw new Error(`browser CDP is published on ${binding.HostIp || "all interfaces"} instead of loopback`);
  }
  return { id: container.id, ip, hostCdpPort: Number(binding.HostPort) };
}

function uuid4(): string {
  return randomUUID();
}

/** The Chromium binary inside the Playwright image, resolved at launch.
 *
 * The image's browsers live under `/ms-playwright/<name>-<build>/`, and the
 * build number changes with the image; globbing the *newest* one beats baking a
 * path into the image (which would be a second thing to bump when the digest
 * moves) and beats `npx playwright launch` (which would start a browser with
 * the driver's own flags, not ours). `chromium_headless_shell` is the
 * lighter binary but has no DevTools `Target` domain we rely on for screenshots
 * of a specific page, so the full `chrome` it is.
 */
export const CHROMIUM_LAUNCH_COMMAND = [
  "sh",
  "-c",
  // Newest build dir wins; `chrome` is the binary, and the headless shell in
  // the same tree is deliberately not used.
  'bin="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)"; ' +
    'if [ -z "$bin" ]; then echo "no chromium in the browsing image" >&2; exit 127; fi; ' +
    'exec "$bin" "$@"',
  "chromium",
];

/** Starts Chromium inside a browser container. Returns when the process is
 * running; the caller then connects CDP (which retries on its own). */
export async function launchChromium(
  docker: Docker,
  containerId: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: [...CHROMIUM_LAUNCH_COMMAND, ...args],
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    // Detached on purpose: this process must outlive the exec stream. A browser
    // killed because nobody was reading its stdout is the failure mode here.
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
  });
  await exec.start({ Detach: true });
}

/** The container's address on a network, or null when it is not on it. */
export async function containerIpOn(docker: Docker, containerId: string, network: string): Promise<string | null> {
  const info = (await docker.getContainer(containerId).inspect().catch(() => null)) as {
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  } | null;
  return info?.NetworkSettings?.Networks?.[network]?.IPAddress ?? null;
}

/** Joins an existing container to a network — the agent surface's route from a
 * workspace sandbox to its own conversation's browser. Never used to move a
 * sandbox onto *another* conversation's network: the caller passes the network
 * created for the conversation it was asked about. */
export async function connectToNetwork(docker: Docker, containerId: string, network: string): Promise<void> {
  await docker.getNetwork(network).connect({ Container: containerId });
}

export async function disconnectFromNetwork(docker: Docker, containerId: string, network: string): Promise<void> {
  // `force` because a container that has the network as its only one cannot
  // leave it gracefully, and because a browser whose CDP socket is still open
  // should not hold the network's removal up for a timeout.
  await docker.getNetwork(network).disconnect({ Container: containerId, Force: true }).catch(() => undefined);
}

/** Stops and removes a browser container. Idempotent: a container the engine
 * has already reaped (`AutoRemove: true`) is the success case, not an error. */
export async function destroyBrowserContainer(docker: Docker, containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 2 });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await container.remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Anything 404-ish from the engine: gone, and therefore already destroyed. */
export function isNotFound(err: unknown): boolean {
  const code = (err as { statusCode?: number } | null)?.statusCode;
  return code === 404 || code === 409;
}

/** A browser container as the sweep sees it: id, labels, and when it started. */
export interface BrowserContainerListing {
  id: string;
  labels: Record<string, string>;
  /** Unix ms, from the engine's own `Created` (an ISO string it stamps itself,
   * so it is the container's age and not ours). */
  createdMs: number;
  state: string;
}

/**
 * Every browser container on this engine, running or not.
 *
 * Empty (not an error) when there is no engine: a sweep on an engineless
 * machine is a no-op. `all: true` is load-bearing for the same reason it is for
 * sandboxes — the default listing is running-only, and a container left behind
 * by a crash is exactly the thing the sweep must see. Browser containers are
 * `AutoRemove: true`, so a *clean* stop removes them; what survives is a
 * container the engine could not reap, or one on a network nothing claims.
 */
export async function listBrowserContainersOn(
  docker: Docker,
  scope: { userId?: string; createdBeforeMs?: number } = {},
): Promise<BrowserContainerListing[]> {
  const listed = (await docker.listContainers({
    all: true,
    filters: { label: [BROWSER_LABEL] },
  })) as { Id: string; Labels?: Record<string, string>; Created?: number; State?: string }[];
  const out: BrowserContainerListing[] = [];
  for (const c of listed) {
    const labels = c.Labels ?? {};
    // The label filter selects on presence; the id is ours only when the value
    // is a uuid. Anything else is a container we did not create in this design
    // and must not touch.
    if (!/^[0-9a-f-]{36}$/.test(labels[BROWSER_LABEL] ?? "")) continue;
    if (scope.userId && labels[BROWSER_USER_LABEL] !== scope.userId) continue;
    // `Created` is in seconds in the Docker API (both endpoints report it that
    // way); a missing one is treated as very old, which is the safe direction
    // for a sweep.
    const createdMs = typeof c.Created === "number" ? c.Created * 1000 : 0;
    if (scope.createdBeforeMs !== undefined && createdMs >= scope.createdBeforeMs) continue;
    out.push({ id: c.Id, labels, createdMs, state: c.State ?? "unknown" });
  }
  return out;
}
