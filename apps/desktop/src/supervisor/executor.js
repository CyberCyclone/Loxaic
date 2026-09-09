import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/**
 * Runs the local executor (apps/server's dist/executor.js) as a Node child
 * of this process — the same ELECTRON_RUN_AS_NODE arrangement server.js uses
 * for the bundled server — and follows its stdout handshake lines into a
 * state the renderer can show.
 *
 * The session token goes down **stdin**, first line, and nowhere else: not
 * env (readable through `ps -E` / procfs on most systems), not argv (same,
 * and it would land in shell history for a hand launch). The child env is
 * built from scratch here, like the server's — the executor's own
 * configuration is four plain variables.
 *
 * The executor reconnects to the server by itself; this only restarts the
 * *process* if it dies unexpectedly, with backoff. Two exits are deliberate
 * and are not restarted: our own `stop()`, and the executor leaving because
 * the server rejected its session (`LOXAIC_EXECUTOR_UNAUTHORIZED`) — a token
 * that was refused will be refused again, and the desktop starts a fresh
 * executor when it has a fresh token.
 *
 * `onState` is called with `{ state, reason }` on every transition:
 *   starting → online ⇄ connecting → offline | unauthorized
 */
export function startExecutor({ entry, cwd, apiBaseUrl, executorId, name, rootsFile, token, log = console.log, onState = () => {} }) {
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let restarts = 0;
  let state = { state: "starting", reason: null };

  const setState = (next, reason = null) => {
    state = { state: next, reason };
    onState(state);
  };

  const spawnChild = () => {
    child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        // Deliberately not `...process.env`: nothing this process happens to
        // hold in its environment belongs in a child that talks to a server.
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        ELECTRON_RUN_AS_NODE: "1",
        LOXAIC_API_URL: apiBaseUrl,
        LOXAIC_EXECUTOR_ID: executorId,
        LOXAIC_EXECUTOR_NAME: name,
        LOXAIC_EXECUTOR_ROOTS_FILE: rootsFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const spawned = child;
    let unauthorized = false;

    // First line: the token. The executor connects as soon as it has it.
    spawned.stdin.write(`${token}\n`);

    createInterface({ input: spawned.stdout }).on("line", (line) => {
      switch (line.trim()) {
        case "LOXAIC_EXECUTOR_CONNECTED":
          restarts = 0;
          setState("online");
          break;
        case "LOXAIC_EXECUTOR_DISCONNECTED":
          if (!stopped && !unauthorized) setState("connecting", "reconnecting to the server");
          break;
        case "LOXAIC_EXECUTOR_UNAUTHORIZED":
          unauthorized = true;
          setState("unauthorized", "the server rejected this session");
          break;
        default:
          log(`[executor] ${line}`);
      }
    });
    createInterface({ input: spawned.stderr }).on("line", (line) => { log(`[executor] ${line}`); });

    spawned.on("error", (err) => {
      log(`[executor] failed to start: ${err.message}`);
      setState("offline", err.message);
    });
    spawned.on("exit", (code, signal) => {
      if (child === spawned) child = null;
      if (stopped || unauthorized) {
        if (!unauthorized) setState("offline", null);
        return;
      }
      const why = signal ? `killed by ${signal}` : `exited with code ${String(code)}`;
      const delay = Math.min(RESTART_BASE_MS * 2 ** restarts, RESTART_MAX_MS);
      restarts++;
      setState("connecting", `${why}; restarting in ${String(Math.round(delay / 1000))}s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopped) spawnChild();
      }, delay);
    });
  };

  spawnChild();
  onState(state);

  return {
    get state() {
      return state;
    },
    /** Tell the executor the roots file changed. */
    reloadRoots() {
      child?.stdin.write(`${JSON.stringify({ type: "roots" })}\n`);
    },
    stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      return new Promise((resolve) => {
        const current = child;
        if (!current || current.exitCode !== null) {
          setState("offline", null);
          resolve();
          return;
        }
        const killTimer = setTimeout(() => { current.kill("SIGKILL"); }, STOP_GRACE_MS);
        current.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        // Closing stdin is the executor's own cue to leave (it exits on
        // stdin close); SIGTERM covers a child that is not reading it.
        current.stdin.end();
        current.kill("SIGTERM");
      });
    },
  };
}
