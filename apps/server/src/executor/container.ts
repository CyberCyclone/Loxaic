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
} from "../sandbox/container-engine.ts";
import type { SandboxHandle } from "../sandbox/provider.ts";
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

function containerIdOf(ref: string): string {
  return ref.slice(LOCAL_CONTAINER_PREFIX.length);
}

/**
 * The engine this machine has, from this process's own environment only.
 * `CONTAINER_SOCKET` pins one; otherwise the usual Docker/Podman/Colima
 * sockets are tried, exactly as the server does it.
 */
async function findEngine(): Promise<Docker | null> {
  const socket = process.env.CONTAINER_SOCKET;
  const list = socket
    ? candidatesFor({ engine: "custom", customSocket: socket })
    : candidatesFor({ engine: "auto", customSocket: null });
  const found = await discoverFrom(list);
  return found?.docker ?? null;
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
): Promise<SandboxHandle> {
  const docker = await requireEngine();
  const id = containerIdOf(ref);
  // Typed as possibly-absent values on purpose: dockerode declares `Labels`
  // as a total record, but a container that was not created by us may carry
  // none of these — and reading one that is missing is the ordinary case here.
  let labels: Record<string, string | undefined>;
  try {
    const info = await docker.getContainer(id).inspect();
    labels = info.Config.Labels;
  } catch {
    throw new ContainerRefError("That container no longer exists on this machine.");
  }
  if (labels[EXECUTOR_LABEL] !== executorId) {
    throw new ContainerRefError("That container was not created by Loxaic on this machine.");
  }
  const folder = labels[FOLDER_LABEL];
  if (!folder || !(await isApproved(folder))) {
    throw new ContainerRefError(`${folder ?? "That container's folder"} is not inside a folder you have chosen for Loxaic`);
  }
  return makeHandle(docker, id);
}
