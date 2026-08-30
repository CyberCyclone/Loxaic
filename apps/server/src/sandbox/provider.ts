/**
 * Sandbox execution is behind this interface so the rest of the codebase
 * (agent executor, routes, WS terminal) never touches a container engine
 * type directly — that's what makes SANDBOX_MODE=host a same-shaped
 * alternative instead of a parallel code path.
 */

export type SandboxKind = "container" | "host";
export type SandboxMode = SandboxKind | "off";

export interface ExecOptions {
  workdir?: string;
  timeoutMs?: number;
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
  fileTree(path?: string): Promise<FileNode[]>;
  /** Absent when the provider has no interactive-terminal support. */
  openTerminal?(): Promise<TerminalSession>;
  isRunning(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface CreateSandboxConfig {
  limits?: {
    memory?: number; // bytes
    cpu?: number;    // nano CPUs (container provider only)
    pids?: number;
  };
  repoUrl?: string;
  branch?: string;
  token?: string;
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  /** Whether this provider can actually be used right now, and why not if not. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  create(userId: string, config: CreateSandboxConfig): Promise<SandboxHandle>;
  /** Reattach to a sandbox by its persisted ref (does not verify it's running). */
  attach(ref: string): Promise<SandboxHandle>;
}

/** SANDBOX_MODE is read at call time (not cached at module load) so a
 * supervisor can set it in the child's env before the server's first sandbox
 * use without an import-order dependency. */
export function getSandboxMode(): SandboxMode {
  const mode = process.env.SANDBOX_MODE;
  if (mode === "host" || mode === "off") return mode;
  return "container";
}

let hostModeWarned = false;

/** Fetches a provider by its own kind, independent of the *current*
 * SANDBOX_MODE — used to operate on a sandbox that was created under a mode
 * different from whatever is configured now (e.g. reaping/reattaching after
 * a mode switch), where the provider that must own the operation is fixed by
 * the sandbox's own history, not today's env. */
export async function getProviderByKind(kind: SandboxKind): Promise<SandboxProvider> {
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
