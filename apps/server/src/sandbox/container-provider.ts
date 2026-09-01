import Docker from "dockerode";
import { pack } from "tar-fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { CappedSink } from "./exec-common.ts";
import { getSandboxSettings } from "../settings.ts";
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
/** Ceiling on one binary write into a container. Generous — a multi-megabyte
 * document over a local socket is fast — but finite, because the caller is an
 * HTTP request handler. */
const BINARY_WRITE_TIMEOUT_MS = 120_000;

let imageTag: string | null = null;

/**
 * The sandbox image name, tagged with a hash of the Dockerfile that defines it.
 *
 * The tag is content-derived on purpose. `ensureImage` builds only when the
 * image is *absent*, so with a fixed tag any change to sandbox.Dockerfile —
 * adding `poppler-utils` for PDF extraction, say — would never reach a
 * deployment that had already built once. The tool needing it would then fail
 * at runtime with a bare exit 127, which is close to undiagnosable from the
 * outside. Hashing the Dockerfile into the tag makes a changed Dockerfile a
 * different image, so the rebuild happens by itself, exactly once.
 *
 * SANDBOX_IMAGE still overrides for anyone supplying their own prebuilt image;
 * they are then responsible for its contents.
 */
function sandboxImage(): string {
  if (process.env.SANDBOX_IMAGE) return process.env.SANDBOX_IMAGE;
  if (imageTag) return imageTag;
  let digest = "base";
  try {
    const context = buildContextDir();
    const hash = createHash("sha256");
    hash.update(readFileSync(path.join(context, "sandbox.Dockerfile")));
    // Everything the Dockerfile COPYs lives under sandbox/, and has to be in
    // the digest for the same reason the Dockerfile itself does: editing
    // extract.py without touching the Dockerfile would otherwise leave every
    // already-built deployment running the old script forever. Hashing the
    // whole directory rather than parsing COPY lines keeps that true for
    // anything added later. Sorted so the digest doesn't depend on readdir
    // order.
    const dir = path.join(context, "sandbox");
    for (const name of readdirSync(dir).sort()) {
      hash.update(name);
      hash.update(readFileSync(path.join(dir, name)));
    }
    digest = hash.digest("hex").slice(0, 12);
  } catch {
    // No build context reachable — nothing can be built here anyway, and
    // ensureImage reports that far more clearly than a throw from a name.
  }
  imageTag = `shannon-sandbox:${digest}`;
  return imageTag;
}

/** Test seam: the tag is memoized, so a suite that rewrites the Dockerfile
 * needs a way to forget it. */
export function resetSandboxImageTag(): void {
  imageTag = null;
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
// Colima all expose. Which sockets are tried comes from the sandbox settings
// (env CONTAINER_SOCKET > an admin's engine pick > auto): "auto" keeps the
// historical order — default Docker socket, then Podman's, then Colima's.
// Re-probed on every call that needs a live engine (not cached as "up"), so a
// stopped-then-started engine is picked up without a restart — but the
// *socket that worked* is remembered, so a live engine doesn't get
// re-discovered on every single sandbox operation.
interface Candidate { label: string; socketPath: string | undefined }

function dockerDefaultCandidate(): Candidate {
  return { label: "default (/var/run/docker.sock)", socketPath: undefined };
}

function colimaCandidate(): Candidate {
  return { label: "colima", socketPath: path.join(os.homedir(), ".colima/default/docker.sock") };
}

function podmanCandidates(): Candidate[] {
  const list: Candidate[] = [];
  if (process.env.XDG_RUNTIME_DIR) {
    list.push({ label: "podman (rootless)", socketPath: path.join(process.env.XDG_RUNTIME_DIR, "podman/podman.sock") });
  }
  list.push({
    label: "podman machine",
    socketPath: path.join(os.homedir(), ".local/share/containers/podman/machine/podman.sock"),
  });
  return list;
}

function candidates(): Candidate[] {
  const { engine, customSocket } = getSandboxSettings();
  // A CONTAINER_SOCKET pin surfaces from settings as engine "custom", so this
  // one branch covers both the env pin and an admin-chosen socket path.
  if (engine === "custom" && customSocket) {
    // Labelled, not pathed: this label ends up in available()'s failure
    // `reason`, which the UNAUTHENTICATED /v1/config forwards verbatim — the
    // raw path would leak the server's username and filesystem layout. The
    // real path stays in the admin-only settings view.
    return [{ label: "custom socket", socketPath: customSocket }];
  }
  // Colima and OrbStack both serve the Docker API, so they belong to the
  // "docker" pick; only the default socket and Colima's are well-known enough
  // to probe blindly (OrbStack takes over the default socket).
  if (engine === "docker") return [dockerDefaultCandidate(), colimaCandidate()];
  if (engine === "podman") return podmanCandidates();
  return [dockerDefaultCandidate(), ...podmanCandidates(), colimaCandidate()];
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
  const generation = engineGeneration;
  const found = await discover();
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

/**
 * Stream bytes into a file in the container.
 *
 * Deliberately not built on {@link execInContainer} the way `writeFile` is:
 * that passes the payload as an *argv argument*, and argv is capped (ARG_MAX,
 * ~2 MB on Linux once the environment is counted). A 25 MB PDF would fail
 * there — and fail as a confusing "argument list too long" from bash, not as
 * anything that names the real limit. So the payload goes over hijacked stdin
 * instead, which has no such cap; only the destination path is an argument.
 *
 * base64 rather than raw bytes because the hijacked stream is the same one
 * Docker frames stdout/stderr onto, and a raw binary payload containing
 * frame-header-shaped bytes is asking for trouble. The ~4/3 inflation is
 * bounded by MAX_DOCUMENT_BYTES.
 */
async function writeBinaryToContainer(
  container: Docker.Container,
  filePath: string,
  data: Buffer,
): Promise<void> {
  const exec = await container.exec({
    Cmd: ["bash", "-c", 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', "_", filePath],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true });

  const err = new CappedSink();
  const modem = container.modem as DemuxCapableModem;
  modem.demuxStream(stream, new CappedSink(), err);

  // Every listener is registered *before* the write starts. Registering the
  // finish handlers after `await`ing the write is a real race: for a small
  // payload the exec can complete and the stream emit end/close before control
  // returns, so a listener attached afterwards waits for an event that already
  // fired and never settles. The timeout is the second half — a stalled socket
  // (dead daemon, paused container) would otherwise hang this forever, and the
  // awaited caller is the upload route, so it would hold an HTTP request and a
  // pooled sandbox open with no error ever surfacing. execInContainer bounds
  // itself the same way.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err2?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err2) reject(err2);
      else resolve();
    };
    const timer = setTimeout(
      () => { finish(new Error(`binary write timed out after ${String(BINARY_WRITE_TIMEOUT_MS)}ms`)); },
      BINARY_WRITE_TIMEOUT_MS,
    );
    stream.on("error", (e: Error) => { finish(e); });
    stream.on("end", () => { finish(); });
    stream.on("close", () => { finish(); });
    stream.end(data.toString("base64"));
  });

  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error(err.text().trim() || `binary write failed (exit ${String(info.ExitCode ?? -1)})`);
  }
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

    writeFileBinary: (filePath, data) => writeBinaryToContainer(container, filePath, data),

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

// ── Per-engine probing (admin settings UI) ────────────────

export interface EngineProbe {
  id: "docker" | "podman";
  available: boolean;
  /** The socket that answered. Admin-only: the public /v1/config omits it. */
  socketPath?: string;
  /** What the engine calls itself, when that differs from the slot it was
   * found in — a Podman service bound to the default Docker socket is
   * reported honestly rather than as "Docker". */
  detectedAs?: "docker" | "podman";
}

/** Long enough for a busy engine, short enough that four dead sockets don't
 * stall the settings screen (they're probed concurrently anyway). */
const PROBE_TIMEOUT_MS = 2_000;

function identifyEngine(version: unknown): "docker" | "podman" | null {
  const v = version as { Platform?: { Name?: string }; Components?: { Name?: string }[] };
  const haystack = [v.Platform?.Name ?? "", ...(v.Components ?? []).map((c) => c.Name ?? "")]
    .join(" ")
    .toLowerCase();
  if (haystack.includes("podman")) return "podman";
  if (haystack.includes("docker")) return "docker";
  return null;
}

async function probeCandidate(c: Candidate): Promise<{ socketPath?: string; detectedAs?: "docker" | "podman" } | null> {
  const docker = c.socketPath
    ? new Docker({ socketPath: c.socketPath, timeout: PROBE_TIMEOUT_MS })
    : new Docker({ timeout: PROBE_TIMEOUT_MS });
  try {
    await docker.ping();
  } catch {
    return null;
  }
  const version: unknown = await docker.version().catch(() => null);
  const detectedAs = version ? identifyEngine(version) : null;
  return { socketPath: c.socketPath ?? "/var/run/docker.sock", ...(detectedAs ? { detectedAs } : {}) };
}

/**
 * Independently probes each engine we know how to find, so the settings GUI
 * can offer Docker and Podman as real choices and grey out whichever isn't
 * installed or running. Deliberately bypasses the serving cache and the
 * configured engine pin — this answers "what *could* you use", not "what are
 * you using".
 */
export async function probeEngines(): Promise<EngineProbe[]> {
  const groups: { id: "docker" | "podman"; list: Candidate[] }[] = [
    { id: "docker", list: [dockerDefaultCandidate(), colimaCandidate()] },
    { id: "podman", list: podmanCandidates() },
  ];
  return Promise.all(
    groups.map(async ({ id, list }) => {
      const results = await Promise.all(list.map((c) => probeCandidate(c)));
      // A Podman service on the default Docker socket answers the docker
      // probe too; prefer a hit whose self-report matches the slot so each
      // engine is attributed to the socket that really is that engine.
      const hit = results.find((r) => r?.detectedAs === id) ?? results.find(Boolean);
      if (!hit) return { id, available: false };
      return { id, available: true, ...hit };
    }),
  );
}

/** IDs of every running container this provider ever creates (all sandboxes
 * carry the shannon.sandbox label). Used by the boot-time orphan sweep.
 * Empty when no engine is reachable — a sweep on a host-mode or engineless
 * machine is a no-op, not an error. */
export async function listSandboxContainers(): Promise<string[]> {
  const found = await getDocker();
  if (!found) return [];
  try {
    const containers = await found.docker.listContainers({
      filters: { label: ["shannon.sandbox"] },
    });
    return containers.map((c) => c.Id);
  } catch {
    return [];
  }
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

      const container = await docker.createContainer({
        Image: sandboxImage(),
        Cmd: ["tail", "-f", "/dev/null"],
        HostConfig: {
          Memory: config.limits?.memory ?? DEFAULT_LIMITS.Memory,
          NanoCpus: config.limits?.cpu ?? DEFAULT_LIMITS.NanoCpus,
          PidsLimit: config.limits?.pids ?? DEFAULT_LIMITS.PidsLimit,
          AutoRemove: true,
          NetworkMode: allowNetwork ? "bridge" : "none",
        },
        Labels: {
          "shannon.user": userId,
          "shannon.sandbox": uuid(),
        },
      });
      await container.start();

      const handle = makeHandle(docker, container.id);

      // A repo clone needs the network, which the sandbox lacks unless an
      // admin enabled it (NetworkMode: "none" by default). We surface the
      // clone failure rather than silently producing an empty repo.
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
