/**
 * The server's view of which local executors are connected right now, and
 * the request/response layer over their sockets.
 *
 * Process-local, like the run registry (#78 owns multi-process). An executor
 * is keyed by its own id — the desktop's `instanceId` — and remembered under
 * its user so the chooser can list "your machines"; a `local` workspace
 * records the id, and the executor provider reaches the socket through
 * `callExecutor` with nothing but that id.
 *
 * Every call has a deadline. An executor that has gone quiet — laptop lid
 * closed, the socket half-open — must surface as a failed tool call with a
 * reason, never as a run that hangs until someone notices. The executor's
 * own `exec` timeout is deliberately the shorter one (protocol.ts), so a
 * command that overruns comes back as a real exit code with its output.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  executorOfflineMessage,
  type ExecutorCapabilities,
  type ExecutorMethod,
  type ResultMessage,
  type ServerToExecutor,
  type TerminalDataMessage,
  type TerminalExitMessage,
} from "./protocol.ts";

export class ExecutorOfflineError extends Error {
  constructor(name: string | null) {
    super(executorOfflineMessage(name));
    this.name = "ExecutorOfflineError";
  }
}

/** The executor answered, and the answer was a refusal or a failure — a path
 * outside its roots, a command that could not spawn. The message is the
 * executor's own, so a user reading a tool result sees what their machine
 * actually objected to. */
export class ExecutorCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorCallError";
  }
}

export class ExecutorTimeoutError extends Error {
  constructor(method: string, name: string | null, timeoutMs: number) {
    super(
      `${name ? `Your machine ${name}` : "The machine this workspace lives on"} did not answer ` +
        `(${method}) within ${String(Math.round(timeoutMs / 1000))}s — is the Loxaic desktop app still running there?`,
    );
    this.name = "ExecutorTimeoutError";
  }
}

export interface ExecutorInfo {
  executorId: string;
  userId: string;
  name: string;
  platform: string;
  capabilities: ExecutorCapabilities;
  roots: string[];
  connectedAt: number;
}

/** What `ws/executor.ts` hands over once a hello has been validated. */
export interface ExecutorConnection extends Omit<ExecutorInfo, "connectedAt"> {
  send(message: ServerToExecutor): void;
  close(code: number, reason: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface TerminalListeners {
  onData(data: string): void;
  onExit(error?: string): void;
}

interface Registered {
  info: ExecutorInfo;
  conn: ExecutorConnection;
  pending: Map<string, Pending>;
  /** Live terminal streams, by the id the server minted for each. */
  terminals: Map<string, TerminalListeners>;
}

const byId = new Map<string, Registered>();
const byUser = new Map<string, Set<string>>();
/** Survives disconnects, so an offline message can still name the machine. */
const lastKnownName = new Map<string, string>();

function failPending(entry: Registered, reason: string): void {
  for (const [id, p] of entry.pending) {
    clearTimeout(p.timer);
    p.reject(new ExecutorCallError(reason));
    entry.pending.delete(id);
  }
  // A terminal whose executor is gone must be *told*, or the panel holding it
  // waits for output from a machine that will never send any.
  for (const [id, listeners] of entry.terminals) {
    entry.terminals.delete(id);
    listeners.onExit(reason);
  }
}

/**
 * Registers a freshly-connected executor. Returns the unregister function
 * its socket's close handler calls.
 *
 * A second connection claiming an id that is already registered *replaces*
 * the first — a desktop that restarted before the server noticed its old
 * socket die is the common case, and refusing it would lock that machine
 * out until a TCP timeout. The old socket is closed and its in-flight calls
 * fail, which is the truth: that process is gone.
 */
export function registerExecutor(conn: ExecutorConnection): () => void {
  const existing = byId.get(conn.executorId);
  if (existing) {
    failPending(existing, "the machine reconnected before this call completed");
    unlink(existing);
    existing.conn.close(4000, "Replaced by a newer connection");
  }
  const entry: Registered = {
    info: {
      executorId: conn.executorId,
      userId: conn.userId,
      name: conn.name,
      platform: conn.platform,
      capabilities: conn.capabilities,
      roots: [...conn.roots],
      connectedAt: Date.now(),
    },
    conn,
    pending: new Map(),
    terminals: new Map(),
  };
  byId.set(conn.executorId, entry);
  lastKnownName.set(conn.executorId, conn.name);
  let ids = byUser.get(conn.userId);
  if (!ids) {
    ids = new Set();
    byUser.set(conn.userId, ids);
  }
  ids.add(conn.executorId);

  return () => {
    // Only this connection may unregister itself: if it was already
    // replaced, the id now belongs to the newer socket.
    if (byId.get(conn.executorId) !== entry) return;
    failPending(entry, "the machine disconnected before this call completed");
    unlink(entry);
  };
}

function unlink(entry: Registered): void {
  byId.delete(entry.info.executorId);
  const ids = byUser.get(entry.info.userId);
  ids?.delete(entry.info.executorId);
  if (ids?.size === 0) byUser.delete(entry.info.userId);
}

export function updateExecutorRoots(executorId: string, roots: string[]): void {
  const entry = byId.get(executorId);
  if (entry) entry.info.roots = [...roots];
}

export function handleExecutorResult(executorId: string, msg: ResultMessage): void {
  const entry = byId.get(executorId);
  const p = entry?.pending.get(msg.id);
  if (!entry || !p) return; // late answer to a call that already timed out
  entry.pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.value);
  else p.reject(new ExecutorCallError(msg.error));
}

/** One open shell on a machine, from the server's side. */
export interface ExecutorTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Opens a shell on `executorId` in `ref`, streaming both ways over the
 * executor's existing socket.
 *
 * Refuses up front when the machine is offline, for the same reason
 * `callExecutor` does: waiting cannot make a disconnected laptop connected,
 * and the panel deserves the real message. Whether the *directory* is
 * allowed is the executor's own answer, which arrives as an `onExit` with a
 * reason — the server does not hold a copy of that decision.
 */
export function openExecutorTerminal(
  executorId: string,
  ref: string,
  listeners: TerminalListeners,
): ExecutorTerminalHandle {
  const entry = byId.get(executorId);
  if (!entry) throw new ExecutorOfflineError(executorName(executorId));
  const terminalId = randomUUID();
  entry.terminals.set(terminalId, listeners);
  entry.conn.send({ type: "terminal.open", terminalId, ref });

  const forget = () => entry.terminals.delete(terminalId);
  return {
    write(data) {
      if (!entry.terminals.has(terminalId)) return;
      entry.conn.send({ type: "terminal.input", terminalId, data });
    },
    resize(cols, rows) {
      if (!entry.terminals.has(terminalId)) return;
      entry.conn.send({ type: "terminal.resize", terminalId, cols, rows });
    },
    close() {
      if (!entry.terminals.has(terminalId)) return;
      forget();
      entry.conn.send({ type: "terminal.close", terminalId });
    },
  };
}

/** Routes a `terminal.data` / `terminal.exit` frame to whoever opened it. */
export function handleExecutorTerminalMessage(
  executorId: string,
  msg: TerminalDataMessage | TerminalExitMessage,
): void {
  const entry = byId.get(executorId);
  const listeners = entry?.terminals.get(msg.terminalId);
  if (!entry || !listeners) return; // a stream nobody is holding any more
  if (msg.type === "terminal.data") {
    listeners.onData(msg.data);
    return;
  }
  entry.terminals.delete(msg.terminalId);
  listeners.onExit(msg.error);
}

export function listExecutors(userId: string): ExecutorInfo[] {
  const ids = byUser.get(userId);
  if (!ids) return [];
  const out: ExecutorInfo[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) out.push({ ...entry.info, roots: [...entry.info.roots] });
  }
  return out;
}

export function getExecutor(executorId: string): ExecutorInfo | null {
  const entry = byId.get(executorId);
  return entry ? { ...entry.info, roots: [...entry.info.roots] } : null;
}

export function executorName(executorId: string): string | null {
  return lastKnownName.get(executorId) ?? null;
}

/**
 * One request to one executor, answered or failed within `timeoutMs`.
 * Offline is decided up front rather than discovered by timeout: a machine
 * that is not connected cannot become connected by waiting fifteen seconds.
 */
export async function callExecutor<T>(
  executorId: string,
  method: ExecutorMethod,
  params: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const entry = byId.get(executorId);
  if (!entry) throw new ExecutorOfflineError(executorName(executorId));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const id = randomUUID();
  // Captured after the guard above: a hoisted function declaration does not
  // keep the narrowing, and `onAbort` is one.
  const conn = entry.conn;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new ExecutorTimeoutError(method, entry.info.name, timeoutMs));
    }, timeoutMs);
    // Cancelling asks the executor to stop; it does **not** settle this
    // promise. The executor kills the command and then answers the original
    // call as normal, so the partial output it produced still comes back and
    // the result arrives through the path it already had. The timeout above
    // stays the backstop for an executor too old to know the message.
    function onAbort() {
      try {
        conn.send({ type: "exec.cancel", id });
      } catch {
        // A socket that has gone: the call will time out, which is the right
        // answer for a machine that stopped listening mid-command.
      }
    }
    // Both paths tear down the timer *and* the abort listener: a listener
    // left on a run's signal outlives the call, and would later send a cancel
    // for an id the executor has long forgotten.
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    entry.pending.set(id, {
      resolve: (value) => { cleanup(); resolve(value as T); },
      reject: (err) => { cleanup(); reject(err); },
      timer,
    });
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      entry.conn.send({ type: "call", id, method, params });
    } catch (err) {
      entry.pending.delete(id);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Test seam. */
export function __resetExecutorsForTest(): void {
  for (const entry of byId.values()) failPending(entry, "reset");
  byId.clear();
  byUser.clear();
  lastKnownName.clear();
}
