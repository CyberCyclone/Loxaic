import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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

async function execHost(cwd: string, command: string[], options?: ExecOptions): Promise<ExecResult> {
  if (command.length === 0) throw new Error("exec requires a non-empty command");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  const child = spawn(command[0], command.slice(1), {
    cwd: options?.workdir ?? cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // The host's own environment plus whatever this one command was given —
    // a git credential, most likely (sandbox/git.ts). Only set when asked, so
    // the default stays exactly what spawn would have done on its own.
    ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
  });

  const out = new CappedSink();
  const err = new CappedSink();
  child.stdout.pipe(out);
  child.stderr.pipe(err);

  const { exitCode, timedOut } = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      // No graceful-then-force here (unlike the supervisor's own child
      // shutdown): an agent-issued command that's overrun its budget gets no
      // benefit from a SIGTERM grace period, and a real container's timeout
      // path (detach-only, no kill at all) is already the looser of the two.
      child.kill("SIGKILL");
      resolve({ exitCode: 124, timedOut: true });
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 128 : -1), timedOut: false });
    });
  });

  return {
    stdout: out.text(),
    stderr: err.text() + (timedOut ? `\n… [timed out after ${String(timeoutMs)}ms]` : ""),
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
  child.stdout.on("data", (chunk: Buffer) => { for (const l of dataListeners) l(chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { for (const l of dataListeners) l(chunk.toString()); });
  child.on("close", () => { for (const l of closeListeners) l(); });
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
        throw new Error(`host sandbox directory is gone: ${sandboxDir}`);
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
