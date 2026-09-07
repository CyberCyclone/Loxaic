/**
 * The wire between the server and a local executor — the process the desktop
 * app runs on a user's own machine so an agent conversation can work in a
 * directory there (a `local` workspace).
 *
 * Shared by both ends: `executor/main.ts` (the executor process, bundled to
 * dist/executor.js) and `ws/executor.ts` + `executor/registry.ts` (the
 * server). Everything is JSON over one WebSocket, `/ws/executor?token=`,
 * opened by the executor. Only two shapes cross it after the greeting: the
 * server issues `call`s, the executor answers each with exactly one `result`.
 *
 * Trust runs one way. The executor authenticates to the server with a session
 * token, so the server knows whose machine it is talking to. The executor
 * does **not** trust the server: a host is not necessarily the user's own,
 * and a compromised or hostile one can send any `call` it likes — so every
 * path in every call is re-checked on the executor against the roots the
 * user chose through their own native folder dialog (executor/service.ts).
 * Nothing in this protocol lets the server *add* a root.
 */
import type { ExecResult, FileNode } from "../sandbox/provider.ts";

export const EXECUTOR_PROTOCOL_VERSION = 1;

export interface ExecutorCapabilities {
  /** Run commands directly in the chosen directory, no isolation. Always true. */
  direct: boolean;
  /** Run them in a container with the directory bind-mounted (a later stage). */
  container: boolean;
}

/** First message on the socket, executor → server. Anything else first is a
 * protocol error and the server closes the socket. */
export interface HelloMessage {
  type: "hello";
  version: number;
  /** This machine's identity — the desktop's `instanceId` when it has one. */
  executorId: string;
  /** What the user calls the machine; shown in the workspace chooser. */
  name: string;
  platform: string;
  capabilities: ExecutorCapabilities;
  /** Directories the user has approved, absolute. Advisory to the server (the
   * chooser lists them); the executor re-checks every call against its own
   * current copy. */
  roots: string[];
}

/** The approved roots changed (the user picked or removed a folder). */
export interface RootsMessage {
  type: "roots";
  roots: string[];
}

export type ResultMessage =
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string };

export type ExecutorToServer = HelloMessage | RootsMessage | ResultMessage;

/** Sent once the hello was accepted and the executor is registered. */
export interface WelcomeMessage {
  type: "welcome";
}

export interface CallMessage {
  type: "call";
  id: string;
  method: ExecutorMethod;
  params: unknown;
}

export type ServerToExecutor = WelcomeMessage | CallMessage;

export type ExecutorMethod =
  | "ping"
  | "create"
  | "attach"
  | "exec"
  | "readFile"
  | "writeFile"
  | "writeFileBinary"
  | "fileTree"
  | "isRunning"
  | "exists"
  | "start"
  | "stop"
  | "destroy";

// ── Per-method params and results ──────────────────────────
// `ref` is the sandbox's identity on the executor: for direct mode it is the
// real (symlink-resolved) path of the approved directory itself.

export interface CreateParams {
  path: string;
  isolation: "direct" | "container";
}
export interface CreateResult {
  ref: string;
}

export interface RefParams {
  ref: string;
}
export interface AttachResult {
  ref: string;
  root: string;
  workdir: string;
}

export interface ExecParams extends RefParams {
  command: string[];
  options?: {
    workdir?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  };
}
export type ExecCallResult = ExecResult;

export interface ReadFileParams extends RefParams {
  path: string;
}
export interface WriteFileParams extends RefParams {
  path: string;
  content: string;
}
/** Bytes ride as base64: the transport is JSON text. */
export interface WriteFileBinaryParams extends RefParams {
  path: string;
  dataBase64: string;
}
export interface FileTreeParams extends RefParams {
  path?: string;
}
export type FileTreeResult = FileNode[];

/** How long the server waits for a `result` before giving up on a call.
 * `exec` gets the command's own timeout plus this margin, so the executor's
 * own timeout — which produces a real exit code and captured output — is the
 * one that fires first; everything else is a quick filesystem operation. */
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;
export const EXEC_TIMEOUT_MARGIN_MS = 5_000;

/** The default `exec` timeout when the caller sets none — mirrors the host
 * provider's own, since that is what runs the command on the far side. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** Lines the executor prints to stdout for the desktop supervisor, which
 * reads them the way it reads the server's `LOXAIC_LISTENING` handshake. */
export const EXECUTOR_STDOUT = {
  connected: "LOXAIC_EXECUTOR_CONNECTED",
  disconnected: "LOXAIC_EXECUTOR_DISCONNECTED",
  /** The session was rejected — the executor exits rather than retrying a
   * token that will never work; the desktop restarts it with a fresh one. */
  unauthorized: "LOXAIC_EXECUTOR_UNAUTHORIZED",
} as const;

/** Control lines the desktop writes to the executor's stdin after the first
 * line (which is the session token and nothing else). */
export interface ExecutorStdinCommand {
  type: "roots";
}

/** What a run is told when the machine a local workspace lives on is not
 * connected. The one message for every executor method, so the model — and
 * the user reading the tool result — see the same thing wherever it fails. */
export function executorOfflineMessage(name: string | null): string {
  const machine = name ? `Your machine ${name}` : "The machine this workspace lives on";
  return `${machine} is offline — open the Loxaic desktop app there and try again.`;
}
