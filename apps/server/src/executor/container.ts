/**
 * Container isolation for a local workspace: the same sandbox image the
 * server uses, running on the *user's own machine*, with only their chosen
 * folder mounted into it.
 *
 * What this buys over direct mode is precisely one thing, and it is worth
 * stating plainly: the agent's commands can no longer see the rest of the
 * machine. Direct mode is a shell running as the user — `~/.ssh` and all —
 * and says so; here the container's view of the filesystem is the image plus
 * one bind mount.
 *
 * Policy is decided here rather than read from the server's settings, because
 * this runs on a laptop that has none: the engine comes from this process's
 * own environment, and the network is on (see below).
 */
import Docker from "dockerode";
import {
  candidatesFor,
  CONTAINER_WORKDIR,
  EXECUTOR_LABEL,
  createSandboxContainer,
  discoverFrom,
  ensureImage,
  makeHandle,
  pingSocket,
} from "../sandbox/container-engine.ts";
import type { SandboxHandle } from "../sandbox/provider.ts";
import { SandboxGoneError } from "../sandbox/errors.ts";
import { LOCAL_CONTAINER_PREFIX } from "./protocol.ts";

/** The bind source, kept on the container so an attach can re-check it
 * against the roots *as they are now* rather than as they were at create. */
const FOLDER_LABEL = "loxaic.localFolder";

export class ContainerRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerRefError";
  }
}

export function isContainerRef(ref: string): boolean {
  return ref.startsWith(LOCAL_CONTAINER_PREFIX);
}

/** What an engine hands out: a hex id, 12 to 64 characters. */
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

/**
 * The id under the prefix, checked for shape *before* it goes anywhere. It
 * is the server's text, and this module's contract is that the server is not
 * trusted — every other server-named field here is confined (the folder by
 * realpath, the container by two labels), but the id was a bare slice that
 * dockerode interpolated into an Engine API path (`/containers/{id}/json`)
 * against a root-equivalent socket. The label check ran only after that
 * request had already been sent.
 */
function containerIdOf(ref: string): string {
  const id = ref.slice(LOCAL_CONTAINER_PREFIX.length);
  if (!CONTAINER_ID_RE.test(id)) throw new ContainerRefError("That is not a container reference.");
  return id;
}

/**
 * How many local containers a server may have this machine hold. Every
 * `create` with container isolation makes a new one, nothing reuses one per
 * folder, and nothing on this side sweeps them (the server's orphan sweep
 * deliberately skips `loxaic.executor`) — so a server opening conversations
 * in a loop, or one that lost its rows in a restart, accumulated containers
 * on the laptop until the engine ran out. The terminal cap beside this
 * exists for the same reason and a container is the heavier object.
 * Deleting a conversation destroys its container, which is how the count
 * comes down.
 */
const MAX_LOCAL_CONTAINERS = 8;

async function countLocalContainers(docker: Docker, executorId: string): Promise<number> {
  const list = await docker.listContainers({ all: true, filters: { label: [`${EXECUTOR_LABEL}=${executorId}`] } });
  return list.length;
}

/**
 * The engine this machine has, from this process's own environment only.
 * `CONTAINER_SOCKET` pins one; otherwise the usual Docker/Podman/Colima
 * sockets are tried, exactly as the server does it.
 */
/**
 * The engine that answered last time, re-checked with a bounded ping before
 * it is reused. `attachLocalContainer` is on the path of every call for a
 * container ref — each `exec`, `readFile`, `isRunning`, every terminal open —
 * and it used to walk every candidate socket on every one of them, with no
 * client timeout, so a stale socket file (a stopped Colima, a Podman machine
 * that is down) sorted before the live one could hang each tool call on
 * connect. The server-side provider caches its engine the same way.
 */
let cachedEngine: { docker: Docker; socketPath: string | null } | null = null;

async function findEngine(): Promise<Docker | null> {
  if (cachedEngine) {
    if (await pingSocket(cachedEngine.socketPath)) return cachedEngine.docker;
    cachedEngine = null;
  }
  const socket = process.env.CONTAINER_SOCKET;
  const list = socket
    ? candidatesFor({ engine: "custom", customSocket: socket })
    : candidatesFor({ engine: "auto", customSocket: null });
  const found = await discoverFrom(list);
  if (!found) return null;
  cachedEngine = { docker: found.docker, socketPath: found.socketPath ?? null };
  return found.docker;
}

/** Test seam: forget the engine, so a suite that stops one can see it gone. */
export function __resetEngineCacheForTest(): void {
  cachedEngine = null;
}

async function requireEngine(): Promise<Docker> {
  const docker = await findEngine();
  if (!docker) {
    throw new ContainerRefError(
      "No container engine is running on this machine — start Docker or Podman, or choose Direct instead.",
    );
  }
  return docker;
}

/**
 * Whether this machine can offer container isolation at all, for the
 * capability the executor advertises. Only asks whether an engine answers;
 * the image is built on first use, which is why creating one is given a
 * generous timeout rather than being pre-warmed here.
 */
export async function containerCapability(): Promise<boolean> {
  return (await findEngine()) !== null;
}

/**
 * Runs as the desktop user on Linux, so files the agent writes into the
 * mounted folder belong to them rather than to the image's `loxaic` user.
 * Docker Desktop on macOS and Windows already maps ownership for bind mounts,
 * and forcing a uid there would only break it.
 *
 * Overriding the user also costs the image's home directory, which that uid
 * cannot write to — hence a writable `HOME`. `/tmp` rather than the mounted
 * folder: the alternative scatters tool dotfiles through someone's project.
 */
function userAndEnv(): { user?: string; env?: string[] } {
  if (process.platform !== "linux") return {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return {};
  return { user: `${String(uid)}:${String(gid)}`, env: ["HOME=/tmp"] };
}

/**
 * Creates a container for `dir`, mounted where a checkout would be.
 *
 * The network is **on**, unlike the server's default. There it is off because
 * a sandbox runs model-directed commands on someone else's machine, and
 * egress is an exfiltration path. Here the user has already agreed to run
 * those commands on their own machine — the alternative they would otherwise
 * pick, Direct, has their whole network *and* their whole filesystem. Denying
 * it would make the safer choice the less useful one and push people to the
 * other.
 */
export async function createLocalContainer(dir: string, executorId: string): Promise<{ ref: string; handle: SandboxHandle }> {
  const docker = await requireEngine();
  if ((await countLocalContainers(docker, executorId)) >= MAX_LOCAL_CONTAINERS) {
    throw new ContainerRefError(
      `This machine already holds ${String(MAX_LOCAL_CONTAINERS)} Loxaic containers — delete a conversation that ` +
        "uses one, or choose Direct for this one.",
    );
  }
  // First use on a machine builds the image, which is minutes — see the
  // create timeout in the registry.
  await ensureImage(docker);
  const handle = await createSandboxContainer(docker, {
    userId: executorId,
    network: true,
    binds: [`${dir}:${CONTAINER_WORKDIR}`],
    labels: { [EXECUTOR_LABEL]: executorId, [FOLDER_LABEL]: dir },
    ...userAndEnv(),
  });
  return { ref: `${LOCAL_CONTAINER_PREFIX}${handle.ref}`, handle };
}

/**
 * Attaches to a container this executor made, for a folder still approved.
 *
 * Both checks are load-bearing, and neither is about the *folder* alone. The
 * label is what stops a server from naming any container id on the machine —
 * a database, someone's production service — and getting an `exec` in it. The
 * folder check is what makes un-approving a folder revoke the container that
 * was mounted on it, rather than leaving a live door into it.
 */
export async function attachLocalContainer(
  ref: string,
  executorId: string,
  isApproved: (dir: string) => Promise<boolean>,
  opts: { requireApprovedFolder?: boolean } = {},
): Promise<SandboxHandle> {
  // Shape first, engine second: a malformed id is refused before anything is
  // asked of the machine, and without an engine in the way.
  const id = containerIdOf(ref);
  const docker = await requireEngine();
  // Typed as possibly-absent values on purpose: dockerode declares `Labels`
  // as a total record, but a container that was not created by us may carry
  // none of these — and reading one that is missing is the ordinary case here.
  let labels: Record<string, string | undefined>;
  try {
    const info = await docker.getContainer(id).inspect();
    labels = info.Config.Labels;
  } catch (err) {
    // Only a 404 is "gone"; an engine that did not answer is not evidence of
    // anything, and the server must not record it as destroyed.
    const status = (err as { statusCode?: unknown } | null)?.statusCode;
    if (status === 404) throw new SandboxGoneError("That container no longer exists on this machine.");
    throw err;
  }
  if (labels[EXECUTOR_LABEL] !== executorId) {
    throw new ContainerRefError("That container was not created by Loxaic on this machine.");
  }
  // Un-approving the folder revokes *reaching into* the container — exec,
  // files, terminals — but must not make it unstoppable: `stop`/`destroy`
  // resolve with this check off, or the one path that could remove a
  // container mounted on a folder the user withdrew would be gated on
  // exactly the condition that makes removing it urgent. Anything the agent
  // left running inside would then keep write access to that folder
  // indefinitely, with nothing on either side ever reclaiming it.
  if (opts.requireApprovedFolder !== false) {
    const folder = labels[FOLDER_LABEL];
    if (!folder || !(await isApproved(folder))) {
      throw new ContainerRefError(`${folder ?? "That container's folder"} is not inside a folder you have chosen for Loxaic`);
    }
  }
  return makeHandle(docker, id);
}
