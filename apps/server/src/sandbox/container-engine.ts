/**
 * Container mechanics: talking to a Docker-API engine, building the sandbox
 * image, creating containers, and the {@link SandboxHandle} over one.
 *
 * Deliberately knows nothing about *policy* — which engine to use, whether the
 * network is allowed, what the retention rules are. All of that arrives as
 * arguments, because this module runs in two very different processes:
 * `container-provider.ts` on the server (policy from the admin settings), and
 * `executor/container.ts` on a user's own laptop (policy from its own
 * environment). Reading the server's settings here would drag `settings.ts`
 * and, through it, `@loxaic/db` into the executor's bundle — a laptop process
 * with the server's database driver inlined into it, which
 * `executor/__tests__/isolation.test.ts` exists to prevent.
 */
import Docker from "dockerode";
import { SandboxGoneError } from "./errors.ts";
import { StringDecoder } from "node:string_decoder";
import { pack } from "tar-fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { CappedSink } from "./exec-common.ts";
import type {
  ExecOptions,
  ExecResult,
  FileNode,
  SandboxHandle,
  TerminalSession,
} from "./provider.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_LIMITS = {
  Memory: 512 * 1024 * 1024, // 512MB
  NanoCpus: 1_000_000_000,   // 1 CPU
  PidsLimit: 100,
};
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** The sandbox user's home, and the checkout inside it that is the handle's
 * `workdir`. Both are fixed by the image (infra/docker/sandbox.Dockerfile,
 * which creates the second), so they are constants rather than configuration
 * — and naming them keeps the exec default and the image in step. */
export const CONTAINER_ROOT = "/home/loxaic";
export const CONTAINER_WORKDIR = `${CONTAINER_ROOT}/repo`;

/** Set on containers a local executor creates, naming the machine's executor.
 * Its presence is what tells the server's orphan sweep to leave one alone —
 * see listSandboxContainersOn. Defined here so both sides read one constant. */
export const EXECUTOR_LABEL = "loxaic.executor";
/** Ceiling on one binary write into a container. Generous — a multi-megabyte
 * document over a local socket is fast — but finite, because the caller is an
 * HTTP request handler. */
const BINARY_WRITE_TIMEOUT_MS = 120_000;
/** Longest killExecGroup waits for its own exec to finish: the marker wait
 * (3s) plus the TERM→KILL grace, with room for a slow engine. */
const KILL_WAIT_MS = 10_000;

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
export function sandboxImage(): string {
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
    //
    // Missing auxiliary files do **not** collapse the whole digest back to
    // "base": a context that has a Dockerfile still deserves a content tag.
    // The packaged app shipped exactly that shape for a while, and the silent
    // fallback meant every install shared one tag no edit could ever change.
    //
    // Files only, recursively, and only a *missing* directory is "no
    // auxiliary files". The loop used to readFileSync every entry, so one
    // subdirectory threw EISDIR into a catch outside the loop — abandoning
    // it, not skipping the entry — and every alphabetically-later file
    // dropped out of the digest. That is the stale-image failure this tag
    // exists to prevent, one `helpers/` (or `__pycache__/`) away.
    const dir = path.join(context, "sandbox");
    try {
      digestDirectory(hash, dir, "");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    digest = hash.digest("hex").slice(0, 12);
  } catch {
    // No Dockerfile reachable — nothing can be built here anyway, and
    // ensureImage reports that far more clearly than a throw from a name.
  }
  imageTag = `loxaic-sandbox:${digest}`;
  return imageTag;
}

function digestDirectory(hash: ReturnType<typeof createHash>, dir: string, prefix: string): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      digestDirectory(hash, path.join(dir, entry.name), `${rel}/`);
      continue;
    }
    if (!entry.isFile()) continue;
    hash.update(rel);
    hash.update(readFileSync(path.join(dir, entry.name)));
  }
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
export interface Candidate { label: string; socketPath: string | undefined }

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

/** Which engine to try, as chosen by whoever owns that policy — the server's
 * admin settings, or the executor's own environment. Kept as a parameter
 * rather than read here, because this module must not reach the server's
 * settings (and through them its database): it also runs inside the local
 * executor, on a user's own laptop. */
export type EnginePick = "auto" | "docker" | "podman" | "custom";

export function candidatesFor(pick: { engine: EnginePick; customSocket: string | null }): Candidate[] {
  const { engine, customSocket } = pick;
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

/** The first candidate whose socket answers a ping, or null. */
export async function discoverFrom(
  list: Candidate[],
): Promise<{ docker: Docker; label: string; socketPath?: string } | null> {
  for (const c of list) {
    // Probed with a bounded client; the one handed back has no timeout, since
    // it goes on to run execs that legitimately take minutes. A socket file
    // with nothing listening behind it can otherwise hang the connect, and
    // the candidates are walked in order — so the cost landed on whichever
    // stale sockets sort before the live one.
    if (!(await pingSocket(c.socketPath ?? null))) continue;
    const docker = c.socketPath ? new Docker({ socketPath: c.socketPath }) : new Docker();
    return { docker, label: c.label, ...(c.socketPath ? { socketPath: c.socketPath } : {}) };
  }
  return null;
}

/** Whether an engine answers on `socketPath` (null: dockerode's default)
 * within the probe timeout. */
export async function pingSocket(socketPath: string | null): Promise<boolean> {
  const probe = socketPath
    ? new Docker({ socketPath, timeout: PROBE_TIMEOUT_MS })
    : new Docker({ timeout: PROBE_TIMEOUT_MS });
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(docker: Docker): Promise<void> {
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
    docker.modem.followProgress(buildStream, (err: Error | null, output: BuildOutput[]) => {
      if (err) {
        reject(err);
        return;
      }
      // A *failed build step* is not an `err`: the daemon reports it as an
      // ordinary progress entry carrying `errorDetail`, and dockerode hands
      // that back as success. Without this the build silently does nothing
      // and the failure resurfaces much later as "No such image" from
      // createContainer — which is exactly how a packaged app whose build
      // context was missing a COPY'd file presented itself: unreadable.
      const failure = output.find((line) => line.error ?? line.errorDetail?.message);
      if (failure) {
        reject(new Error(`sandbox image build failed: ${failure.errorDetail?.message ?? failure.error ?? "unknown error"}`));
        return;
      }
      resolve();
    });
  });
}

/** What the daemon streams back while building — dockerode types this as
 * `any[]`, and the only fields that matter here are the failure ones. */
interface BuildOutput {
  error?: string;
  errorDetail?: { message?: string };
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

/**
 * Kills a command started by `execInContainer`, from *inside* the container.
 *
 * The Docker Engine API has no kill-exec call — `Exec` offers only
 * start/resize/inspect — and that is the API we speak to every engine through
 * dockerode, so Docker, Podman, OrbStack and Colima all behave the same
 * (verified: Podman leaves the process running after the client detaches
 * exactly as Docker does). Detaching the stream, which is all the old timeout
 * did, leaves the work running until the container is reaped.
 *
 * So the kill happens in the container's own userspace: a cancellable command
 * runs under `setsid -w`, its session leader records its own PGID to a file,
 * and this reads that file and signals the **group**. The group, not the pid —
 * `bash -lc "npm install"` has grandchildren, and those are what hold the CPU.
 *
 * The PGID file rather than matching the command line: `pgrep -f <marker>`
 * also matches the `setsid` process itself, which is *not* in the new group,
 * so killing what it reports leaves the real tree running. Recording `$$` from
 * inside the new session is unambiguous.
 *
 * Best-effort by construction: the process may have exited between the
 * decision to cancel and this landing, which is an ordinary race and not an
 * error. Needs `setsid -w` from util-linux — present in the Ubuntu-based
 * sandbox image, absent from busybox, so a base-image change needs this
 * re-checked.
 */
async function killExecGroup(container: Docker.Container, pgidFile: string): Promise<void> {
  // The marker is *waited for*, bounded, not read once: `exec.start()`
  // resolves as soon as the stream is hijacked, which can be before the
  // wrapper shell has been scheduled inside the container and written its
  // PGID — an abort landing in that window (a loaded engine makes it wide)
  // found an empty file and silently left the command running. Thirty
  // tenths of a second is well past any exec start-up; a marker that never
  // appears means the command already exited and its trap removed it.
  const script =
    `for i in $(seq 1 30); do [ -s ${pgidFile} ] && break; sleep 0.1; done; ` +
    `PGID=$(cat ${pgidFile} 2>/dev/null); ` +
    `[ -n "$PGID" ] || exit 0; ` +
    `kill -TERM -"$PGID" 2>/dev/null; sleep 0.2; kill -KILL -"$PGID" 2>/dev/null; ` +
    `rm -f ${pgidFile}; exit 0`;
  try {
    const killer = await container.exec({
      Cmd: ["bash", "-c", script],
      AttachStdout: true,
      AttachStderr: false,
    });
    const s = await killer.start({ hijack: true, stdin: false });
    // Drained, and awaited until the killer itself finishes — so "the
    // command is gone" is true when this returns, which is what the caller
    // relies on. Bounded, since a wedged engine must not hold the run.
    s.resume();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { s.destroy(); resolve(); }, KILL_WAIT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      s.on("end", done);
      s.on("close", done);
      s.on("error", done);
    });
  } catch {
    // A dead container, or an engine that refused the exec — nothing left to
    // kill either way, and the caller has already stopped waiting.
  }
}

/** What a command the user stopped before it started reports: exit 130,
 * like a SIGINT, and the same notice a cancelled one carries. */
function stoppedBeforeStart(): ExecResult {
  return { stdout: "", stderr: "… [stopped by the user]", exitCode: 130, truncated: false, timedOut: false };
}

async function execInContainer(
  container: Docker.Container,
  command: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  // A signal that is already aborted means nothing should start — and after
  // a Stop, every remaining call in a batch arrives here in that state.
  // Starting the exec and settling "cancelled" at once used to race the
  // wrapper: the killer read a PGID file the shell had not yet written,
  // found nothing, and the caller was told exit 130 for a command that then
  // ran to completion inside the container.
  if (options?.signal?.aborted) return stoppedBeforeStart();

  // Every exec is wrapped, not only a cancellable one: the *timeout* needs
  // the same marker, and gating it on a signal left a timed-out clone, a
  // wedged document extraction — the one exec whose input is genuinely
  // untrusted — or a REST exec merely detached, running until the container
  // was reaped. `setsid -w` waits for the child and returns its exit status,
  // so the wrapper is invisible in the result (exec-cancel.test.ts asserts
  // that); the inner shell records its own PGID (it is the new session's
  // leader, so `$$` *is* the group) for killExecGroup to find, and clears
  // the file on the way out whether the command succeeded, failed, or was
  // killed.
  //
  // Not `exec "$@"`: that replaces the shell, which drops the wrapper — and
  // with it any chance of recording the group before the command starts.
  const pgidFile = `/tmp/loxaic-exec-${randomUUID()}.pgid`;
  const cmd = [
    "setsid", "-w", "bash", "-c",
    `trap 'rm -f ${pgidFile}' EXIT; echo $$ > ${pgidFile}; "$@"`,
    "_", ...command,
  ];

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    // The handle's workdir, not the root: #62. The image creates it, so it is
    // always there to be exec'd in — including for the clone that fills it.
    WorkingDir: options?.workdir ?? CONTAINER_WORKDIR,
    // Per-command only: it lands in this exec's process and nowhere else in
    // the container, which is what lets a git credential ride here rather
    // than in a URL or a file. See sandbox/git.ts.
    ...(options?.env ? { Env: Object.entries(options.env).map(([k, v]) => `${k}=${v}`) } : {}),
  });

  // Checked again after every await before the listener exists, because
  // `addEventListener("abort")` on a signal that has already fired never
  // fires. A Stop landing during these Engine API round trips — hundreds of
  // milliseconds when Docker is busy — was otherwise lost outright, and the
  // command ran to completion. Here nothing has started: the created exec is
  // simply never started, and goes with the container.
  if (options?.signal?.aborted) return stoppedBeforeStart();

  const stream = await exec.start({ hijack: true, stdin: false });

  const out = new CappedSink();
  const err = new CappedSink();
  // Docker frames stdout/stderr into one hijacked stream with an 8-byte
  // header per chunk. demuxStream handles frames split across TCP reads,
  // which a hand-rolled `chunk[0]` / `chunk.slice(8)` parser does not.
  const modem = container.modem as DemuxCapableModem;
  modem.demuxStream(stream, out, err);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  const outcome = await new Promise<"done" | "timeout" | "cancelled">((resolve, reject) => {
    const signal = options?.signal;
    let settled = false;
    const settle = (v: "done" | "timeout" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const timer = setTimeout(() => {
      // Detaching alone used to be the whole timeout: the process kept running
      // inside the container until it was reaped. Now the group is killed too
      // when there is a marker to find it by (#119).
      stream.destroy();
      settle("timeout");
    }, timeoutMs);
    function onAbort() {
      stream.destroy();
      settle("cancelled");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted during `exec.start`: the command is running now, so this one
    // takes the kill path rather than returning early.
    if (signal?.aborted) onAbort();

    stream.on("end", () => { settle("done"); });
    stream.on("close", () => { settle("done"); });
    stream.on("error", (e: Error) => {
      // A destroyed stream reports an error on some engines; that is this
      // function doing its job, not a failure to report upwards.
      if (settled) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
  const timedOut = outcome === "timeout";

  // Kills what the detach above only stopped listening to. Awaited so the
  // command is actually gone before the sandbox is reported free — a
  // cancelled `npm install` still holding the CPU is the bug being fixed.
  if (outcome !== "done") await killExecGroup(container, pgidFile);

  let exitCode = timedOut ? 124 : outcome === "cancelled" ? 130 : 0;
  if (outcome === "done") {
    const inspected = await exec.inspect().catch(() => null);
    // Running===true means the process outlived its stream; treat as unknown.
    exitCode = inspected?.ExitCode ?? -1;
  }

  return {
    stdout: out.text(),
    stderr:
      err.text()
      + (timedOut ? `\n… [timed out after ${String(timeoutMs)}ms]` : "")
      + (outcome === "cancelled" ? "\n… [stopped by the user]" : ""),
    exitCode,
    truncated: out.truncated || err.truncated,
    timedOut,
  };
}

export function makeHandle(docker: Docker, containerId: string): SandboxHandle {
  const container = docker.getContainer(containerId);
  return {
    provider: "container",
    ref: containerId,
    root: CONTAINER_ROOT,
    workdir: CONTAINER_WORKDIR,

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

    async fileTree(treePath = CONTAINER_ROOT) {
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
        // Same default as every other exec (#62): a terminal opens where the
        // work is, not at the home directory above it.
        WorkingDir: CONTAINER_WORKDIR,
        // Without this bash announces `TERM=dumb` and emits no colour or
        // cursor control at all, which wastes the one thing a real PTY buys.
        Env: ["TERM=xterm-256color"],
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
      //
      // Decoded, not `chunk.toString()`: a PTY carries box-drawing and emoji
      // routinely and the stream splits wherever it likes, so a multi-byte
      // character arriving as 1 + 2 bytes became two replacement characters.
      const decoder = new StringDecoder("utf8");
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          const text = decoder.write(chunk);
          if (text) for (const l of dataListeners) l(text);
          cb();
        },
      });
      const modem = container.modem as DemuxCapableModem;
      modem.demuxStream(stream, sink, sink);

      return {
        tty: true,
        write: (data) => { stream.write(Buffer.from(data)); },
        // The PTY's window size, which is what makes `vim`, `less` and line
        // wrapping agree with what the user actually sees. Failures are
        // swallowed: a resize arriving after the shell exited is ordinary,
        // and losing the session over it would be absurd.
        resize: (cols, rows) => { void exec.resize({ w: cols, h: rows }).catch(() => undefined); },
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

    async exists() {
      try {
        await container.inspect();
        return true;
      } catch {
        return false;
      }
    },

    async start() {
      // inspect() first, so a container the engine has never heard of throws
      // here rather than being silently created or ignored: this call is the
      // manager's "paused or gone?" discriminator, and answering "fine" for a
      // container that no longer exists would hand back a handle whose every
      // later exec fails one at a time instead.
      //
      // Only a 404 means gone. Anything else — the engine unreachable, a
      // timeout — is rethrown as itself, so the manager surfaces an error the
      // user can retry rather than tombstoning a paused workspace that is
      // still sitting on disk (sandbox/errors.ts).
      let info: Docker.ContainerInspectInfo;
      try {
        info = await container.inspect();
      } catch (err) {
        if (statusCodeOf(err) === 404) throw new SandboxGoneError(`container ${container.id} no longer exists`);
        throw err;
      }
      if (info.State.Running) return;
      try {
        await container.start();
      } catch (err) {
        // 304: something else resumed it between the inspect and the start —
        // the inspect→start race — which is success, not failure.
        if (statusCodeOf(err) === 304) return;
        if (statusCodeOf(err) === 404) throw new SandboxGoneError(`container ${container.id} no longer exists`);
        throw err;
      }
    },

    async stop() {
      // Stop only. The container — and with it the conversation's edits, its
      // repo checkout and anything installed into it — stays on disk until
      // something explicitly destroys it. This is why AutoRemove is off.
      await container.stop({ t: 10 }).catch(() => undefined);
    },

    async destroy() {
      await container.stop({ t: 10 }).catch(() => undefined);
      await container.remove({ force: true }).catch(() => undefined);
    },
  };
}

/** dockerode reports the engine's HTTP status on its errors; anything else is
 * a transport failure with no status at all. */
function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
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


export interface CreateContainerOptions {
  /** Recorded as the `loxaic.user` label. For a conversation sandbox this is
   * the conversation's *owner* — the same id as the row's `ownerId` — so a
   * sweep scoped to one user selects rows and containers by one identity. */
  userId: string;
  limits?: { memory?: number; cpu?: number; pids?: number };
  /** Whether the container may reach the network at all. */
  network: boolean;
  extraHosts?: string[];
  /** `<host path>:<container path>` mounts — local container isolation. */
  binds?: string[];
  /** `uid:gid` to run as, so files written into a bind keep their owner. */
  user?: string;
  env?: string[];
  labels?: Record<string, string>;
}

/**
 * Creates and starts a sandbox container, and hands back a handle over it.
 *
 * Every security-relevant flag below is fixed here rather than left to the
 * caller, because they are the same wherever a sandbox runs; what the caller
 * decides is only what genuinely differs between a server and a laptop —
 * network, mounts, and who to run as.
 */
export async function createSandboxContainer(
  docker: Docker,
  opts: CreateContainerOptions,
): Promise<SandboxHandle> {
  const container = await docker.createContainer({
    Image: sandboxImage(),
    ...(opts.env ? { Env: opts.env } : {}),
    // Only ever set by the local executor on Linux — see its own module for
    // why, and why macOS must not have it.
    ...(opts.user ? { User: opts.user } : {}),
    Cmd: ["tail", "-f", "/dev/null"],
    HostConfig: {
      // A local workspace's own folder, mounted where the checkout would be.
      // Nothing else on the machine is visible to the container, which is
      // the whole point of choosing this over running directly.
      ...(opts.binds && opts.binds.length > 0 ? { Binds: opts.binds } : {}),
      Memory: opts.limits?.memory ?? DEFAULT_LIMITS.Memory,
      NanoCpus: opts.limits?.cpu ?? DEFAULT_LIMITS.NanoCpus,
      PidsLimit: opts.limits?.pids ?? DEFAULT_LIMITS.PidsLimit,
      // Off, deliberately. A sandbox is a coding session's working
      // directory, and AutoRemove would delete it the moment the
      // container stopped — including the idle pause an untouched
      // conversation gets, and a host reboot. Reclaim is explicit
      // instead: deleting the conversation, or the abandoned reaper.
      AutoRemove: false,
      // Run tini as PID 1. Both halves of this matter once sandboxes are
      // long-lived and stopping them is routine:
      //
      // - **Signals.** PID 1 gets no default handlers, so `tail -f` as
      //   PID 1 simply ignores SIGTERM: every `stop()` waited out the full
      //   10-second grace period and was then SIGKILLed (`Exited (137)`).
      //   That was tolerable when stopping meant deleting; it is not when
      //   an idle pause is a normal, frequent event. tini forwards the
      //   signal and exits immediately.
      // - **Zombies.** A container that now lives for days accumulates
      //   orphaned children from every `bash -c` the agent runs, and PID 1
      //   is the only thing that can reap them. Without this they pile up
      //   against PidsLimit until the sandbox can no longer fork.
      Init: true,
      NetworkMode: opts.network ? "bridge" : "none",
      ...(opts.extraHosts && opts.extraHosts.length > 0 ? { ExtraHosts: opts.extraHosts } : {}),
      // Everything below runs model-directed commands, so the container
      // gets no capability it cannot demonstrate a need for.
      //
      // The image already runs as a non-root user (`USER loxaic`,
      // uid 1001), which is the single biggest control here and predates
      // this change. These add the two things that non-root alone does
      // not give you:
      //
      // - `CapDrop: ALL` — even as uid 1001 the container starts with a
      //   default capability set (CHOWN, SETUID, NET_RAW, …). Nothing the
      //   sandbox does — bash, file edits, git clone, the extractors —
      //   needs any of them.
      // - `no-new-privileges` — stops a setuid binary inside the image
      //   from ever raising privileges, which is what makes dropping the
      //   capabilities durable rather than a starting position.
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
    Labels: {
      "loxaic.user": opts.userId,
      "loxaic.sandbox": uuid(),
      ...opts.labels,
    },
  });
  await container.start();
  return makeHandle(docker, container.id);
}

/**
 * IDs of every container this provider ever created (all sandboxes carry the
 * loxaic.sandbox label), **running or stopped**. Used by the boot-time orphan
 * sweep. Empty when the engine cannot answer — a sweep on a host-mode or
 * engineless machine is a no-op, not an error.
 *
 * `all: true` is load-bearing. dockerode lists only running containers by
 * default, which was complete while a stopped sandbox was a removed one. Now
 * that stopping is a pause, an orphan — a container whose row is gone — comes
 * to rest *stopped*, i.e. exactly the state the default listing cannot see, and
 * every one of them would accumulate on the host forever with nothing able to
 * find it. Observed directly: an afternoon of test runs left two dozen.
 */
export async function listSandboxContainersOn(
  docker: Docker,
  scope: { userId?: string; createdBeforeMs?: number } = {},
): Promise<string[]> {
  const { userId, createdBeforeMs } = scope;
  try {
    const listed = await docker.listContainers({
      all: true,
      // `userId` narrows to one `loxaic.user` — a test's scoped sweep only.
      filters: { label: userId ? ["loxaic.sandbox", `loxaic.user=${userId}`] : ["loxaic.sandbox"] },
    });
    // `Created` is the engine's clock in whole seconds, rounded *down* — so
    // the comparison is made in seconds too. Against milliseconds, a container
    // made half a second after the cutoff carried a timestamp before it and
    // read as old, which is the one direction this filter exists to prevent
    // (found by checking the default against a real engine, not by a test:
    // the container-lifecycle cases pin 0 and Infinity and cannot see it).
    // The same second counts as young. See sweepOrphanSandboxes for what the
    // cutoff is for and how clock skew degrades.
    const cutoffSeconds = createdBeforeMs === undefined ? undefined : Math.floor(createdBeforeMs / 1000);
    const containers =
      cutoffSeconds === undefined ? listed : listed.filter((c) => c.Created < cutoffSeconds);
    // Containers a *local executor* made are excluded, and must be: they
    // carry the same marker but are claimed by no row in this database, so
    // the orphan sweep would destroy every one of them — and the engine is
    // shared the moment someone runs a Solo or Host instance on the machine
    // they also use as their own executor, which is an ordinary setup rather
    // than a corner case. They belong to that machine's executor, which has
    // its own lifecycle for them.
    return containers.filter((c) => !(EXECUTOR_LABEL in c.Labels)).map((c) => c.Id);
  } catch {
    return [];
  }
}
