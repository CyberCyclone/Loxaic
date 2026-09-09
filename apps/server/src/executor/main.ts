/**
 * The local executor — the process the desktop app runs on a user's machine
 * so their `local` agent workspaces can execute there. Bundled to
 * dist/executor.js (tsup.config.ts) and spawned by apps/desktop/src/
 * supervisor/executor.js under ELECTRON_RUN_AS_NODE.
 *
 * Configuration is deliberately split by sensitivity:
 * - env: `LOXAIC_API_URL`, `LOXAIC_EXECUTOR_ID`, `LOXAIC_EXECUTOR_NAME`,
 *   `LOXAIC_EXECUTOR_ROOTS_FILE` — none of it secret.
 * - stdin, first line: the session token. Never env (readable from `ps` on
 *   many systems) and never argv (same, and it lands in shell history).
 * - stdin, later lines: JSON control commands, currently `{type:"roots"}`
 *   meaning "re-read the roots file, the user changed it".
 *
 * stdout is a handshake channel the desktop reads line by line (protocol.ts's
 * EXECUTOR_STDOUT); everything else this process has to say goes to stderr.
 * The socket URL carries the token and is therefore never printed.
 *
 * Reconnects with backoff whenever the socket drops, except on 4001: a
 * rejected session will not become accepted by retrying, so the process
 * exits and lets the desktop start a new one when it has a new token.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { containerCapability } from "./container.ts";
import { createExecutorService, createRefResolver } from "./service.ts";
import { createExecutorTerminals } from "./terminal.ts";
import {
  EXECUTOR_PROTOCOL_VERSION,
  EXECUTOR_STDOUT,
  type ExecutorStdinCommand,
  type ExecutorToServer,
  type ServerToExecutor,
} from "./protocol.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[executor] ${name} is not set`);
    process.exit(2);
  }
  return value;
}

const apiUrl = required("LOXAIC_API_URL").replace(/\/+$/, "");
const executorId = required("LOXAIC_EXECUTOR_ID");
const rootsFile = required("LOXAIC_EXECUTOR_ROOTS_FILE");
const name = process.env.LOXAIC_EXECUTOR_NAME ?? os.hostname();

/** Well inside the server's 10s hello deadline. */
const CAPABILITY_PROBE_MS = 3_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function loadRoots(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(rootsFile, "utf8")) as { roots?: unknown };
    if (!Array.isArray(parsed.roots)) return [];
    return parsed.roots.filter((r): r is string => typeof r === "string" && r.length > 0);
  } catch {
    // Missing file means the user has not chosen a folder yet — no roots,
    // which the service treats as "refuse everything".
    return [];
  }
}

let roots = loadRoots();
const service = createExecutorService({ roots: () => roots, executorId });

/**
 * In-flight calls, so an `exec.cancel` can reach one. Keyed by the server's
 * call id — the same id its `result` will carry, which is what lets a cancel
 * name a specific command rather than "whatever is running".
 *
 * Cleared when the call settles, so a cancel arriving after the command
 * finished finds nothing and does nothing, which is the common race.
 */
const inFlight = new Map<string, AbortController>();
const terminals = createExecutorTerminals({
  resolver: createRefResolver({ roots: () => roots, executorId }),
  executorId,
  send: (message) => { send(message); },
});

let token: string | null = null;
let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let exiting = false;

function send(message: ExecutorToServer): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

/** `ws` hands frames over as a Buffer, an ArrayBuffer, or a Buffer list. */
function frameText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function connect(): void {
  if (!token || exiting) return;
  const wsBase = apiUrl.replace(/^http/, "ws");
  const socket = new WebSocket(`${wsBase}/ws/executor?token=${encodeURIComponent(token)}`);
  ws = socket;

  socket.on("open", () => {
    // Probed per connection rather than once at startup: someone who starts
    // Docker after opening the app should get container isolation offered on
    // the next reconnect rather than after a restart. Bounded, and false on
    // timeout — a wedged socket must not hold up the hello the server is
    // waiting for.
    void Promise.race([
      containerCapability(),
      new Promise<boolean>((resolve) => setTimeout(() => { resolve(false); }, CAPABILITY_PROBE_MS)),
    ])
      .catch(() => false)
      .then((container) => {
        send({
          type: "hello",
          version: EXECUTOR_PROTOCOL_VERSION,
          executorId,
          name,
          platform: process.platform,
          capabilities: { direct: true, container },
          roots,
        });
      });
  });

  socket.on("message", (data) => {
    let msg: ServerToExecutor;
    try {
      msg = JSON.parse(frameText(data)) as ServerToExecutor;
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      attempt = 0;
      console.log(EXECUTOR_STDOUT.connected);
      return;
    }
    if (msg.type === "terminal.open") {
      void terminals.open(msg.terminalId, msg.ref);
      return;
    }
    if (msg.type === "terminal.input") {
      terminals.input(msg.terminalId, msg.data);
      return;
    }
    if (msg.type === "terminal.resize") {
      // Acted on for a container's PTY, ignored for a pipe session — the
      // server sends this for either, and does not need to know which.
      terminals.resize(msg.terminalId, msg.cols, msg.rows);
      return;
    }
    if (msg.type === "terminal.close") {
      terminals.close(msg.terminalId);
      return;
    }
    if (msg.type === "exec.cancel") {
      // Abort only — the call still answers through its normal path below,
      // carrying whatever the command produced before it was killed. A
      // cancel for a call that already finished is an ordinary race.
      inFlight.get(msg.id)?.abort();
      return;
    }
    const { id, method, params } = msg;
    const controller = new AbortController();
    inFlight.set(id, controller);
    const settle = (message: ExecutorToServer) => {
      inFlight.delete(id);
      send(message);
    };
    void service
      .handle(method, params, controller.signal)
      .then((value) => { settle({ type: "result", id, ok: true, value }); })
      .catch((err: unknown) => {
        settle({ type: "result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
      });
  });

  socket.on("error", (err) => {
    // A close event follows every error; log here, reconnect there.
    console.error(`[executor] socket error: ${err.message}`);
  });

  socket.on("close", (code) => {
    if (ws === socket) ws = null;
    // Shells belong to the connection that asked for them: a server that has
    // gone away must not leave bash processes running on someone's laptop.
    terminals.closeAll();
    console.log(EXECUTOR_STDOUT.disconnected);
    if (exiting) return;
    if (code === 4001) {
      console.log(EXECUTOR_STDOUT.unauthorized);
      exiting = true;
      process.exit(0);
    }
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer || exiting) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  if (token === null) {
    const candidate = line.trim();
    if (!candidate) {
      console.error("[executor] expected the session token on stdin's first line");
      process.exit(2);
    }
    token = candidate;
    connect();
    return;
  }
  let cmd: Partial<ExecutorStdinCommand>;
  try {
    cmd = JSON.parse(line) as Partial<ExecutorStdinCommand>;
  } catch {
    return;
  }
  if (cmd.type === "roots") {
    roots = loadRoots();
    send({ type: "roots", roots });
  }
});

// The desktop closing our stdin is how we learn it is gone (or wants us
// gone): there is nothing to reconnect to on its behalf, so leave.
stdin.on("close", () => {
  exiting = true;
  ws?.close(1000, "desktop closed");
  process.exit(0);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    exiting = true;
    ws?.close(1000, signal);
    process.exit(0);
  });
}
