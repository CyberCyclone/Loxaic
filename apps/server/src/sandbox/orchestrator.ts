import Docker from "dockerode";
import { Writable } from "node:stream";
import { v4 as uuid } from "uuid";

// Any Docker-API-compatible engine works (Docker, Podman, OrbStack, Colima).
// CONTAINER_SOCKET overrides the default /var/run/docker.sock — see docs/RUNTIME.md.
const docker = process.env.CONTAINER_SOCKET
  ? new Docker({ socketPath: process.env.CONTAINER_SOCKET })
  : new Docker();

const SANDBOX_IMAGE = "shannon-sandbox";
const DEFAULT_LIMITS = {
  Memory: 512 * 1024 * 1024, // 512MB
  NanoCpus: 1_000_000_000,   // 1 CPU
  PidsLimit: 100,
};

/** Per-stream cap on captured exec output. Anything past this is dropped. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Default wall-clock budget for a single exec. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

export type SandboxConfig = {
  limits?: {
    memory?: number;   // bytes
    cpu?: number;      // nano CPUs
    pids?: number;
  };
  repoUrl?: string;
  branch?: string;
  token?: string;
};

export type SandboxInfo = {
  id: string;
  containerId: string;
  status: string;
  repoUrl?: string;
  createdAt: string;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when either stream hit MAX_OUTPUT_BYTES. */
  truncated: boolean;
  /** True when the exec exceeded its timeout and was abandoned. */
  timedOut: boolean;
};

export async function createSandbox(
  userId: string,
  config: SandboxConfig = {},
): Promise<SandboxInfo> {
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    Cmd: ["tail", "-f", "/dev/null"],
    HostConfig: {
      Memory: config.limits?.memory ?? DEFAULT_LIMITS.Memory,
      NanoCpus: config.limits?.cpu ?? DEFAULT_LIMITS.NanoCpus,
      PidsLimit: config.limits?.pids ?? DEFAULT_LIMITS.PidsLimit,
      AutoRemove: true,
      NetworkMode: "none",
    },
    Labels: {
      "shannon.user": userId,
      "shannon.sandbox": uuid(),
    },
  });

  await container.start();

  const info = await container.inspect();

  // A repo clone needs the network, which the sandbox deliberately lacks
  // (NetworkMode: "none"). Callers that need a repo must provide it another
  // way; we surface the failure rather than silently producing an empty repo.
  if (config.repoUrl) {
    let url = config.repoUrl;
    if (config.token) {
      url = url.replace("https://", `https://x-access-token:${config.token}@`);
    }
    const clone = await execInContainer(container, [
      "git", "clone", "--depth=1",
      ...(config.branch ? [`--branch=${config.branch}`] : []),
      url,
      "/home/shannon/repo",
    ]);
    if (clone.exitCode !== 0) {
      await stopSandbox(container.id);
      throw new Error(`Repo clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
    }
  } else {
    // Every sandbox gets the working directory the agent tools default to.
    await execInContainer(container, ["mkdir", "-p", "/home/shannon/repo"]);
  }

  return {
    id: container.id,
    containerId: container.id,
    status: info.State?.Status || "running",
    repoUrl: config.repoUrl,
    createdAt: new Date().toISOString(),
  };
}

export async function stopSandbox(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop({ t: 10 }).catch(() => {});
  await container.remove({ force: true }).catch(() => {});
}

/**
 * Collects a stream into a string, hard-capped at MAX_OUTPUT_BYTES.
 * Past the cap bytes are counted but discarded, so a runaway command can't
 * grow the server's heap.
 */
class CappedSink extends Writable {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    const room = MAX_OUTPUT_BYTES - this.bytes;
    if (room <= 0) {
      this.truncated = true;
    } else if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes = MAX_OUTPUT_BYTES;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
    cb();
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${body}\n… [output truncated at ${MAX_OUTPUT_BYTES} bytes]` : body;
  }
}

export async function execInContainer(
  container: Docker.Container,
  command: string[],
  options?: { workdir?: string; timeoutMs?: number },
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options?.workdir || "/home/shannon",
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const out = new CappedSink();
  const err = new CappedSink();
  // Docker frames stdout/stderr into one hijacked stream with an 8-byte
  // header per chunk. demuxStream handles frames split across TCP reads,
  // which a hand-rolled `chunk[0]` / `chunk.slice(8)` parser does not.
  container.modem.demuxStream(stream, out, err);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  let timedOut = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // The Docker API has no "kill exec" call; detaching is all we can do.
      // The process stays until the container is reaped, bounded by the
      // container's own memory/CPU/pid limits.
      stream.destroy();
      resolve();
    }, timeoutMs);

    stream.on("end", () => { clearTimeout(timer); resolve(); });
    stream.on("close", () => { clearTimeout(timer); resolve(); });
    stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
  });

  let exitCode = timedOut ? 124 : 0;
  if (!timedOut) {
    const inspected = await exec.inspect().catch(() => null);
    // Running===true means the process outlived its stream; treat as unknown.
    exitCode = inspected?.ExitCode ?? -1;
  }

  return {
    stdout: out.text(),
    stderr: err.text() + (timedOut ? `\n… [timed out after ${timeoutMs}ms]` : ""),
    exitCode,
    truncated: out.truncated || err.truncated,
    timedOut,
  };
}

export async function getSandboxFileTree(
  container: Docker.Container,
  path: string = "/home/shannon",
): Promise<{ name: string; type: "file" | "dir"; path: string }[]> {
  const { stdout } = await execInContainer(container, [
    "find", path, "-maxdepth", "3", "-printf", "%y %P\n",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type, relPath] = line.split(" ", 2);
      return {
        name: relPath.split("/").pop() || relPath,
        type: type === "d" ? "dir" : "file",
        path: `${path}/${relPath}`,
      };
    });
}

export async function readSandboxFile(
  container: Docker.Container,
  path: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await execInContainer(container, ["cat", "--", path]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `cat failed (exit ${exitCode})`);
  return stdout;
}

export async function writeSandboxFile(
  container: Docker.Container,
  path: string,
  content: string,
): Promise<void> {
  // Content and path travel as bash positional params ($1/$2) rather than
  // being spliced into the script text, so no value can escape into the
  // command. base64 keeps binary-ish content and newlines intact.
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const { stderr, exitCode } = await execInContainer(container, [
    "bash", "-c",
    'mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 -d > "$1"',
    "_", path, encoded,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `write failed (exit ${exitCode})`);
}

export function getContainer(containerId: string): Docker.Container {
  return docker.getContainer(containerId);
}

/** IDs of every running container this module ever creates (all sandboxes
 * carry the shannon.sandbox label). Used by the boot-time orphan sweep. */
export async function listSandboxContainers(): Promise<string[]> {
  try {
    const containers = await docker.listContainers({
      filters: { label: ["shannon.sandbox"] },
    });
    return containers.map((c) => c.Id);
  } catch {
    return [];
  }
}

/** True when the container still exists and is running. */
export async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    return info.State?.Running === true;
  } catch {
    return false;
  }
}
