import Docker from "dockerode";
import { pack } from "tar-fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { CappedSink } from "./exec-common.ts";
import type {
  CreateSandboxConfig,
  ExecOptions,
  ExecResult,
  FileNode,
  SandboxHandle,
  SandboxProvider,
  TerminalSession,
} from "./provider.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_LIMITS = {
  Memory: 512 * 1024 * 1024, // 512MB
  NanoCpus: 1_000_000_000,   // 1 CPU
  PidsLimit: 100,
};
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

function sandboxImage(): string {
  return process.env.SANDBOX_IMAGE ?? "shannon-sandbox";
}

/**
 * Where the sandbox image's Dockerfile lives. In dev / Docker Compose
 * deployments that's the repo's infra/docker/; a packaged desktop build ships
 * its own copy (SANDBOX_BUILD_CONTEXT, staged by build-server.mjs) since the
 * repo isn't present there.
 */
function buildContextDir(): string {
  if (process.env.SANDBOX_BUILD_CONTEXT) return process.env.SANDBOX_BUILD_CONTEXT;
  return path.resolve(__dirname, "../../../../infra/docker");
}

// ── Engine discovery ──────────────────────────────────────
// dockerode speaks the Docker Engine API, which Docker, Podman, OrbStack, and
// Colima all expose — CONTAINER_SOCKET (an explicit override) always wins;
// otherwise the default socket is tried first, then a couple of well-known
// Podman locations. Re-probed on every call that needs a live engine (not
// cached as "up"), so a stopped-then-started engine is picked up without a
// restart — but the *socket that worked* is remembered, so a live engine
// doesn't get re-discovered on every single sandbox operation.
interface Candidate { label: string; socketPath: string | undefined }

function candidates(): Candidate[] {
  if (process.env.CONTAINER_SOCKET) {
    return [{ label: process.env.CONTAINER_SOCKET, socketPath: process.env.CONTAINER_SOCKET }];
  }
  const home = os.homedir();
  const list: Candidate[] = [{ label: "default (/var/run/docker.sock)", socketPath: undefined }];
  if (process.env.XDG_RUNTIME_DIR) {
    list.push({ label: "podman (rootless)", socketPath: path.join(process.env.XDG_RUNTIME_DIR, "podman/podman.sock") });
  }
  list.push({ label: "podman machine (macOS)", socketPath: path.join(home, ".local/share/containers/podman/machine/podman.sock") });
  return list;
}

let cached: { docker: Docker; label: string } | null = null;

async function discover(): Promise<{ docker: Docker; label: string } | null> {
  for (const c of candidates()) {
    const docker = c.socketPath ? new Docker({ socketPath: c.socketPath }) : new Docker();
    try {
      await docker.ping();
      return { docker, label: c.label };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
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
  const found = await discover();
  cached = found;
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

async function ensureImage(docker: Docker): Promise<void> {
  const image = sandboxImage();
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Not present — build it below.
  }
  const contextDir = buildContextDir();
  if (!existsSync(path.join(contextDir, "sandbox.Dockerfile"))) {
    throw new Error(`sandbox image "${image}" not found and no Dockerfile at ${contextDir} to build it`);
  }
  const tarStream = pack(contextDir);
  const buildStream = await docker.buildImage(tarStream, { t: image, dockerfile: "sandbox.Dockerfile" });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * dockerode types `Container.modem` as `any`; this is the one method of it
 * this file relies on, narrowed by hand so that reliance doesn't leak `any`
 * into the rest of the function.
 */
interface DemuxCapableModem {
  demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void;
}

async function execInContainer(
  container: Docker.Container,
  command: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options?.workdir ?? "/home/shannon",
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const out = new CappedSink();
  const err = new CappedSink();
  // Docker frames stdout/stderr into one hijacked stream with an 8-byte
  // header per chunk. demuxStream handles frames split across TCP reads,
  // which a hand-rolled `chunk[0]` / `chunk.slice(8)` parser does not.
  const modem = container.modem as DemuxCapableModem;
  modem.demuxStream(stream, out, err);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  const timedOut = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The Docker API has no "kill exec" call; detaching is all we can do.
      // The process stays until the container is reaped, bounded by the
      // container's own memory/CPU/pid limits.
      stream.destroy();
      resolve(true);
    }, timeoutMs);

    stream.on("end", () => { clearTimeout(timer); resolve(false); });
    stream.on("close", () => { clearTimeout(timer); resolve(false); });
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
    stderr: err.text() + (timedOut ? `\n… [timed out after ${String(timeoutMs)}ms]` : ""),
    exitCode,
    truncated: out.truncated || err.truncated,
    timedOut,
  };
}

function makeHandle(docker: Docker, containerId: string): SandboxHandle {
  const container = docker.getContainer(containerId);
  return {
    provider: "container",
    ref: containerId,
    root: "/home/shannon",
    workdir: "/home/shannon/repo",

    exec: (command, options) => execInContainer(container, command, options),

    async readFile(filePath) {
      const { stdout, stderr, exitCode } = await execInContainer(container, ["cat", "--", filePath]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `cat failed (exit ${String(exitCode)})`);
      return stdout;
    },

    async writeFile(filePath, content) {
      // Content and path travel as bash positional params ($1/$2) rather than
      // being spliced into the script text, so no value can escape into the
      // command. base64 keeps binary-ish content and newlines intact.
      const encoded = Buffer.from(content, "utf8").toString("base64");
      const { stderr, exitCode } = await execInContainer(container, [
        "bash", "-c",
        'mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 -d > "$1"',
        "_", filePath, encoded,
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `write failed (exit ${String(exitCode)})`);
    },

    async fileTree(treePath = "/home/shannon") {
      const { stdout } = await execInContainer(container, [
        "find", treePath, "-maxdepth", "3", "-printf", "%y %P\n",
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line): FileNode => {
          const [type, relPath] = line.split(" ", 2);
          return {
            name: relPath.split("/").pop() ?? relPath,
            type: type === "d" ? "dir" : "file",
            path: `${treePath}/${relPath}`,
          };
        });
    },

    async openTerminal(): Promise<TerminalSession> {
      const exec = await container.exec({
        Cmd: ["bash"],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });
      const stream = await exec.start({ hijack: true, stdin: true });

      const dataListeners: ((data: string) => void)[] = [];
      // Despite Tty:true — which the Docker API docs say disables stream
      // multiplexing — this engine still frames exec output with the same
      // 8-byte header non-Tty execs use (confirmed against a live container:
      // the first bytes were 01 00 00 00 00 00 00 3c, i.e. stdout/60 bytes,
      // immediately followed by real terminal escape codes). Passing the
      // same sink as both the stdout and stderr target merges the demuxed
      // frames back into one ordered stream, which is what a real terminal
      // shows and what a raw `stream.on("data", ...)` listener assumed but
      // never actually got.
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          for (const l of dataListeners) l(chunk.toString());
          cb();
        },
      });
      const modem = container.modem as DemuxCapableModem;
      modem.demuxStream(stream, sink, sink);

      return {
        write: (data) => { stream.write(Buffer.from(data)); },
        onData: (listener) => { dataListeners.push(listener); },
        onClose: (listener) => { stream.on("close", listener); },
        close: () => { stream.end(); },
      };
    },

    async isRunning() {
      try {
        const info = await container.inspect();
        return info.State.Running;
      } catch {
        return false;
      }
    },

    async stop() {
      await container.stop({ t: 10 }).catch(() => undefined);
      await container.remove({ force: true }).catch(() => undefined);
    },
  };
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

      const container = await docker.createContainer({
        Image: sandboxImage(),
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

      const handle = makeHandle(docker, container.id);

      // A repo clone needs the network, which the sandbox deliberately lacks
      // (NetworkMode: "none"). Callers that need a repo must provide it
      // another way; we surface the failure rather than silently producing
      // an empty repo.
      if (config.repoUrl) {
        let url = config.repoUrl;
        if (config.token) url = url.replace("https://", `https://x-access-token:${config.token}@`);
        const clone = await handle.exec([
          "git", "clone", "--depth=1",
          ...(config.branch ? [`--branch=${config.branch}`] : []),
          url,
          "/home/shannon/repo",
        ]);
        if (clone.exitCode !== 0) {
          await handle.stop();
          throw new Error(`Repo clone failed (exit ${String(clone.exitCode)}): ${clone.stderr.trim()}`);
        }
      } else {
        // Every sandbox gets the working directory the agent tools default to.
        await handle.exec(["mkdir", "-p", "/home/shannon/repo"]);
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
