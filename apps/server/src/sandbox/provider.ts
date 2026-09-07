/**
 * Sandbox execution is behind this interface so the rest of the codebase
 * (agent executor, routes, WS terminal) never touches a container engine
 * type directly — that's what makes SANDBOX_MODE=host a same-shaped
 * alternative instead of a parallel code path.
 */

import { getSandboxSettings } from "../settings.ts";

/**
 * Which provider owns a sandbox. `container` and `host` are the two the
 * server itself can run; `executor` is a directory on a *user's own machine*,
 * driven over `/ws/executor` by the desktop app there (sandbox/executor-
 * provider.ts). It is deliberately absent from `SandboxMode`: it is chosen by
 * a conversation's `local` workspace, never by the deployment's SANDBOX_MODE
 * or an admin setting, and nothing may let a caller pick it per request —
 * `POST /v1/sandboxes` derives its kind from the mode and so can never mint
 * one (sandbox/__tests__/executor-provider.test.ts).
 */
export type SandboxKind = "container" | "host" | "executor";
export type SandboxMode = "container" | "host" | "off";

export interface ExecOptions {
  workdir?: string;
  timeoutMs?: number;
  /**
   * Extra environment for this one command, merged over the sandbox's own.
   * Exists so a credential can reach exactly one process and nothing else —
   * see sandbox/git.ts. **Never logged.**
   */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when either stream hit MAX_OUTPUT_BYTES. */
  truncated: boolean;
  /** True when the exec exceeded its timeout and was abandoned. */
  timedOut: boolean;
}

export interface FileNode {
  name: string;
  type: "file" | "dir";
  path: string;
}

/** A live interactive shell session, for the `/ws/sandbox/:id` terminal. */
export interface TerminalSession {
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** A single sandbox's execution surface — one container, or one host directory. */
export interface SandboxHandle {
  readonly provider: SandboxKind;
  /** Opaque provider-specific reference (container id, or host directory path). Persisted as sandboxes.container_id. */
  readonly ref: string;
  /** Root directory everything must resolve under. */
  readonly root: string;
  /** Default working directory (the repo checkout, if any). */
  readonly workdir: string;
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Binary counterpart of {@link writeFile}, for bytes that aren't text —
   * an uploaded PDF on its way to an in-sandbox extractor. Separate rather
   * than an overload because the transports genuinely differ: the container
   * provider cannot pass megabytes as an exec argument. */
  writeFileBinary(path: string, data: Buffer): Promise<void>;
  fileTree(path?: string): Promise<FileNode[]>;
  /** Absent when the provider has no interactive-terminal support. */
  openTerminal?(): Promise<TerminalSession>;
  isRunning(): Promise<boolean>;
  /**
   * Whether the sandbox still exists at all — **true for a stopped one**.
   *
   * The distinction `isRunning()` cannot make, and the one that matters once
   * stopping is a pause rather than a teardown: "paused, resume it" and "gone,
   * build a new one" are different answers to the same false. Deliberately
   * observational, so a caller that only wants to know can ask without
   * starting anything.
   */
  exists(): Promise<boolean>;
  /**
   * Resume a stopped sandbox, so `exec` works again and its files are as they
   * were left. Throws when there is nothing left to resume; a no-op when it is
   * already running.
   */
  start(): Promise<void>;
  /**
   * Stop execution **without discarding anything**. The sandbox's filesystem
   * survives and {@link start} brings it back.
   *
   * This is the pause an idle conversation gets, and it is deliberately not a
   * teardown: a sandbox holds a coding session's actual work — edits, a repo
   * checkout, installed dependencies — and someone returning after lunch must
   * find it intact. Reclaiming space is {@link destroy}'s job, and only two
   * things ask for it: deleting the conversation, and the abandoned-sandbox
   * reaper.
   */
  stop(): Promise<void>;
  /**
   * Permanently remove the sandbox and everything in it. Irreversible, and
   * therefore never called by an idle timer.
   */
  destroy(): Promise<void>;
}

export interface CreateSandboxConfig {
  limits?: {
    memory?: number; // bytes
    cpu?: number;    // nano CPUs (container provider only)
    pids?: number;
  };
  /** Clone this into the workdir. Needs network, which containers lack unless
   * an admin enabled it — the clone failure is surfaced, never an empty repo. */
  repoUrl?: string;
  /** Branch to clone (`--branch`). The remote's default when absent. */
  branch?: string;
  /** Create and check out this branch from `branch` after cloning — the branch
   * an agent works on, so its commits never land on the base directly. */
  newBranch?: string;
  /** Credentials and identity for the clone. The token reaches git through
   * the exec environment for exactly that command (sandbox/git.ts), never
   * through the URL — a URL-embedded token persists in `.git/config` inside a
   * model-directed environment. */
  git?: {
    token?: string;
    identity?: { name: string; email: string };
  };
  /**
   * A `local` workspace: the directory `path` on the machine whose desktop
   * app registered as `executorId`. Only the executor provider reads this;
   * the path is re-validated against that machine's own approved roots on
   * every call, so a value here is a request, not an authorization.
   */
  local?: {
    executorId: string;
    path: string;
    isolation: "direct" | "container";
    /** The conversation owner — the machine must be registered by them,
     * whoever's tool call is creating the sandbox. */
    ownerId: string;
  };
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  /** Whether this provider can actually be used right now, and why not if not. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  create(userId: string, config: CreateSandboxConfig): Promise<SandboxHandle>;
  /** Reattach to a sandbox by its persisted ref (does not verify it's running). */
  attach(ref: string): Promise<SandboxHandle>;
}

/** Resolved at call time (never cached at module load) so a supervisor can
 * set SANDBOX_MODE in the child's env before the server's first sandbox use
 * without an import-order dependency, and so an admin's GUI change takes
 * effect on the next tool call rather than needing a restart. Precedence is
 * env > persisted > default — see ../settings.ts. */
export function getSandboxMode(): SandboxMode {
  return getSandboxSettings().mode;
}

let hostModeWarned = false;

/** Fetches a provider by its own kind, independent of the *current*
 * SANDBOX_MODE — used to operate on a sandbox that was created under a mode
 * different from whatever is configured now (e.g. reaping/reattaching after
 * a mode switch), where the provider that must own the operation is fixed by
 * the sandbox's own history, not today's env. */
export async function getProviderByKind(kind: SandboxKind): Promise<SandboxProvider> {
  if (kind === "executor") {
    const { getExecutorProvider } = await import("./executor-provider.ts");
    return getExecutorProvider();
  }
  if (kind === "host") {
    if (!hostModeWarned) {
      hostModeWarned = true;
      console.warn(
        "[sandbox] SANDBOX_MODE=host: agent commands run directly on this machine, with NO isolation. " +
          "Only use this if you trust everything the agent might be asked to run.",
      );
    }
    const { getHostProvider } = await import("./host-provider.ts");
    return getHostProvider();
  }
  const { getContainerProvider } = await import("./container-provider.ts");
  return getContainerProvider();
}

/**
 * Returns the currently-configured provider, or null when sandboxes are
 * disabled (SANDBOX_MODE=off).
 */
export async function getSandboxProvider(): Promise<SandboxProvider | null> {
  const mode = getSandboxMode();
  if (mode === "off") return null;
  return getProviderByKind(mode);
}
