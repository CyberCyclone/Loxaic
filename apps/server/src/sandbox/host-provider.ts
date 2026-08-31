import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const FILE_TREE_MAX_DEPTH = 3;

/** Where host-mode sandboxes live. Read at call time — see provider.ts. */
function hostRoot(): string {
  return process.env.SANDBOX_HOST_ROOT
    ?? path.join(process.env.SHANNON_DATA_DIR ?? process.cwd(), "sandboxes");
}

async function execHost(cwd: string, command: string[], options?: ExecOptions): Promise<ExecResult> {
  if (command.length === 0) throw new Error("exec requires a non-empty command");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  const child = spawn(command[0], command.slice(1), {
    cwd: options?.workdir ?? cwd,
    stdio: ["ignore", "pipe", "pipe"],
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

/** Bash over plain pipes — no PTY, so no colors/job-control/prompt shaping,
 * but it works everywhere with no native dependency. Good enough as a
 * baseline for a feature (host-mode terminal) that's already an explicit
 * no-isolation opt-in. */
function openHostTerminal(cwd: string): TerminalSession {
  const child = spawn("bash", [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const dataListeners: ((data: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => { for (const l of dataListeners) l(chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { for (const l of dataListeners) l(chunk.toString()); });
  child.on("close", () => { for (const l of closeListeners) l(); });
  return {
    write: (data) => { child.stdin.write(data); },
    onData: (listener) => { dataListeners.push(listener); },
    onClose: (listener) => { closeListeners.push(listener); },
    close: () => { child.kill(); },
  };
}

function makeHandle(sandboxDir: string): SandboxHandle {
  const workdir = path.join(sandboxDir, "repo");
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

    openTerminal: () => Promise.resolve(openHostTerminal(workdir)),

    async isRunning() {
      try {
        return (await stat(sandboxDir)).isDirectory();
      } catch {
        return false;
      }
    },

    async stop() {
      // Ephemeral by design, matching the container provider: a host
      // sandbox is scratch space for one conversation, not a place to keep
      // anything. Deleting it on stop (idle reap or explicit DELETE) is the
      // same lifecycle a container gets with AutoRemove.
      await rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
    },
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
        let url = config.repoUrl;
        if (config.token) url = url.replace("https://", `https://x-access-token:${config.token}@`);
        const clone = await handle.exec([
          "git", "clone", "--depth=1",
          ...(config.branch ? [`--branch=${config.branch}`] : []),
          url,
          workdir,
        ]);
        if (clone.exitCode !== 0) {
          await handle.stop();
          throw new Error(`Repo clone failed (exit ${String(clone.exitCode)}): ${clone.stderr.trim()}`);
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
