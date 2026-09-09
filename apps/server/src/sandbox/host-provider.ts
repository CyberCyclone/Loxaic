import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { SandboxGoneError } from "./errors.ts";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CappedSink } from "./exec-common.ts";
import { cloneInto } from "./git.ts";
import type {
  CreateSandboxConfig,
  ExecOptions,
  ExecResult,
  FileNode,
  SandboxHandle,
  SandboxProvider,
  TerminalSession,
} from "./provider.ts";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const FILE_TREE_MAX_DEPTH = 3;

/** Where host-mode sandboxes live. Read at call time — see provider.ts. */
function hostRoot(): string {
  return process.env.SANDBOX_HOST_ROOT
    ?? path.join(process.env.LOXAIC_DATA_DIR ?? process.cwd(), "sandboxes");
}

/**
 * Process groups this process has spawned and not yet seen exit. `detached:
 * true` is what lets a cancel or timeout take a command's whole tree, but it
 * also detaches those trees from *this* process's own death: a Ctrl-C on a
 * dev server or a desktop quit no longer reaches them, and the only thing
 * that would have killed them — the timeout timer — dies with the parent.
 * So they are killed on the way out here. `exit` handlers must be
 * synchronous, which process.kill is.
 */
const liveGroups = new Set<number>();
process.once("exit", () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

async function execHost(cwd: string, command: string[], options?: ExecOptions): Promise<ExecResult> {
  if (command.length === 0) throw new Error("exec requires a non-empty command");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  // A signal that is already aborted means nothing should start. After a
  // Stop every remaining call in a batch arrives here in that state (the
  // loop re-checks per call), and spawning anyway — then returning before
  // the `error` listener below was attached — meant an async spawn failure
  // (ENOENT for a command not on PATH, EAGAIN under fork pressure) was an
  // unhandled `error` event: the server under SANDBOX_MODE=host, or the
  // user's desktop executor, exiting.
  if (options?.signal?.aborted) {
    return { stdout: "", stderr: "… [stopped by the user]", exitCode: 130, truncated: false, timedOut: false };
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: options?.workdir ?? cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so cancelling or timing out can take the whole
    // tree. `bash -lc "npm install"` spawns grandchildren, and signalling
    // only the direct child leaves those running — which is what the old
    // timeout did (#119).
    detached: true,
    // The host's own environment plus whatever this one command was given —
    // a git credential, most likely (sandbox/git.ts). Only set when asked, so
    // the default stays exactly what spawn would have done on its own.
    ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
  });

  if (child.pid !== undefined) liveGroups.add(child.pid);

  /** SIGKILL the group, falling back to the child alone where process
   * groups do not exist, and ignoring the race where it has already exited. */
  const killGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      // ESRCH: already gone between the check and the signal — nothing to
      // do. Anything else (EINVAL/ENOSYS where there are no process groups:
      // Windows, where `detached` opens a console instead) means the group
      // kill is not available here, and killing what we can beats killing
      // nothing — which is what swallowing every errno used to do, while
      // reporting exit 130 for a command still running.
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  };

  const out = new CappedSink();
  const err = new CappedSink();
  child.stdout.pipe(out);
  child.stderr.pipe(err);

  const { exitCode, timedOut, cancelled } = await new Promise<{
    exitCode: number;
    timedOut: boolean;
    cancelled: boolean;
  }>((resolve, reject) => {
    const signal = options?.signal;
    const timer = setTimeout(() => {
      // No graceful-then-force here (unlike the supervisor's own child
      // shutdown): an agent-issued command that's overrun its budget gets no
      // benefit from a SIGTERM grace period.
      killGroup();
      resolve({ exitCode: 124, timedOut: true, cancelled: false });
    }, timeoutMs);
    const onAbort = () => {
      killGroup();
      // Resolved here rather than waiting for `exit`: the point of cancelling
      // is that the caller stops waiting *now*. The kill above is what stops
      // the work; this is what stops the run hanging on it.
      settle({ exitCode: 130, timedOut: false, cancelled: true });
    };
    const settle = (v: { exitCode: number; timedOut: boolean; cancelled: boolean }) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    // The emitter is attended before anything can settle the promise: an
    // `error` with no listener is a thrown exception, whatever else happened.
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      reject(e);
    });
    child.on("exit", (code, sig) => {
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      settle({ exitCode: code ?? (sig ? 128 : -1), timedOut: false, cancelled: false });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    stdout: out.text(),
    stderr:
      err.text()
      + (timedOut ? `\n… [timed out after ${String(timeoutMs)}ms]` : "")
      + (cancelled ? "\n… [stopped by the user]" : ""),
    exitCode,
    truncated: out.truncated || err.truncated,
    timedOut,
  };
}

async function walk(dir: string, base: string, depth: number, out: FileNode[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable/vanished — skip rather than fail the whole tree.
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    out.push({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", path: abs });
    if (entry.isDirectory() && depth < FILE_TREE_MAX_DEPTH) {
      await walk(abs, base, depth + 1, out);
    }
  }
}

/**
 * Bash over plain pipes — no PTY, so no prompt, no echo, no colours and no
 * job control, and `tty: false` says so rather than leaving the client to
 * infer it from a window that looks dead. A PTY here would mean node-pty, a
 * native module: the packaged desktop runs this code under Electron's own
 * Node with `npmRebuild: false`, so a binding built for system Node would not
 * load, and the executor (same code, the user's machine) has the same
 * constraint. The container provider gets a real PTY for free because Docker
 * allocates it inside the container.
 *
 * Exported for the executor, which runs exactly this on the user's own
 * machine — a shell there is the same authority `exec` already has (direct
 * mode is explicitly not isolation), so it is the approved directory that
 * gates opening one, not the shell's own reach afterwards.
 */
export function openPipeTerminal(cwd: string): TerminalSession {
  const child = spawn("bash", [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const dataListeners: ((data: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  // Pipe reads land wherever the kernel split them, so a multi-byte character
  // can arrive as 1 + 2 bytes; `chunk.toString()` turned each half into a
  // replacement character. The decoder holds the partial sequence.
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  const emit = (text: string) => { if (text) for (const l of dataListeners) l(text); };
  child.stdout.on("data", (chunk: Buffer) => { emit(out.write(chunk)); });
  child.stderr.on("data", (chunk: Buffer) => { emit(err.write(chunk)); });
  child.on("close", () => { for (const l of closeListeners) l(); });
  // spawn() reports failure asynchronously as `error`, and an `error` with no
  // listener is an uncaught exception: a machine with no `bash` on PATH took
  // down the executor on the user's laptop — or, in host mode, the server.
  // Routed to the close listeners so the panel gets its terminal.exit rather
  // than a socket that goes quiet. stdin can EPIPE the same way after the
  // shell exits.
  child.on("error", (e) => {
    emit(`\r\n[${e.message}]\r\n`);
    for (const l of closeListeners) l();
  });
  child.stdin.on("error", () => undefined);
  return {
    tty: false,
    write: (data) => { child.stdin.write(data); },
    onData: (listener) => { dataListeners.push(listener); },
    onClose: (listener) => { closeListeners.push(listener); },
    close: () => { child.kill(); },
  };
}

/**
 * A handle over a directory the *user* owns, for the local executor
 * (executor/service.ts): root and workdir are the directory itself, and
 * `stop()`/`destroy()` only ever forget — nothing here may delete a folder
 * this process did not create. Contrast `makeHandle`, whose directory is a
 * throwaway the provider made and whose `destroy()` removes it.
 */
export function attachDirectory(dir: string): SandboxHandle {
  return makeHandle(dir, { workdir: dir, destroy: () => Promise.resolve() });
}

function makeHandle(
  sandboxDir: string,
  opts: { workdir?: string; destroy?: () => Promise<void> } = {},
): SandboxHandle {
  const workdir = opts.workdir ?? path.join(sandboxDir, "repo");
  const destroy = opts.destroy ?? (async () => {
    await rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
  });
  return {
    provider: "host",
    ref: sandboxDir,
    root: sandboxDir,
    workdir,

    exec: (command, options) => execHost(workdir, command, options),

    async readFile(filePath) {
      return readFile(filePath, "utf8");
    },

    async writeFile(filePath, content) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    },

    async writeFileBinary(filePath, data) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
    },

    async fileTree(treePath = sandboxDir) {
      const out: FileNode[] = [];
      await walk(treePath, treePath, 1, out);
      return out;
    },

    openTerminal: () => Promise.resolve(openPipeTerminal(workdir)),

    async isRunning() {
      try {
        return (await stat(sandboxDir)).isDirectory();
      } catch {
        return false;
      }
    },

    // A host sandbox has no process, so existing and running are the same
    // question — unlike a container, which can be present but stopped.
    async exists() {
      try {
        return (await stat(sandboxDir)).isDirectory();
      } catch {
        return false;
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; a host sandbox has no process to start.
    async start() {
      // A host sandbox has nothing to restart — commands are spawned per
      // exec — so "resumable" here means the directory is still there. Throwing
      // when it isn't keeps this provider's start() answering the same
      // question the container one does: paused, or gone?
      if (!existsSync(sandboxDir)) {
        throw new SandboxGoneError(`host sandbox directory is gone: ${sandboxDir}`);
      }
    },

    async stop() {
      // Nothing to do, and that is the point: a host sandbox holds the
      // conversation's files, so pausing it must not touch them. It used to
      // `rm -rf` here, which meant an idle reap (or a settings change) silently
      // deleted work someone was coming back to. Reclaiming is destroy()'s job.
    },

    destroy,
  };
}

let provider: SandboxProvider | null = null;

export function getHostProvider(): SandboxProvider {
  provider ??= {
    kind: "host",

    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async so callers don't special-case providers that never need it.
    async available() {
      return { ok: true };
    },

    async create(userId: string, config: CreateSandboxConfig) {
      const sandboxDir = path.join(hostRoot(), randomUUID());
      const workdir = path.join(sandboxDir, "repo");
      await mkdir(workdir, { recursive: true });
      const handle = makeHandle(sandboxDir);

      if (config.repoUrl) {
        try {
          await cloneInto(handle, config, workdir);
        } catch (err) {
          // destroy, not stop: create() is throwing, so nothing will ever
          // claim this directory.
          await handle.destroy();
          throw err;
        }
      }
      void userId; // Unlike the container provider, host mode has no per-user isolation to label.
      return handle;
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; this provider's ref *is* the handle's identity, nothing to await.
    async attach(ref: string) {
      return makeHandle(ref);
    },
  };
  return provider;
}
