import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 10_000;

/**
 * Spawn the bundled server as a Node child of this process
 * (ELECTRON_RUN_AS_NODE turns the Electron binary into plain Node) and wait
 * for its `SHANNON_LISTENING <port>` stdout handshake — the same pattern
 * main.js already uses for tsnet-proxy's `LISTENING` line.
 *
 * Returns { port, stop } — `stop` sends SIGTERM (the server drains and closes
 * its db pool), escalating to SIGKILL after a grace period.
 */
export function startServer({ entry, cwd, env, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const stderrTail = [];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`server did not report SHANNON_LISTENING within ${HANDSHAKE_TIMEOUT_MS}ms\n${stderrTail.join("\n")}`));
    }, HANDSHAKE_TIMEOUT_MS);

    const stop = () =>
      new Promise((resolveStop) => {
        if (child.exitCode !== null) { resolveStop(); return; }
        const killTimer = setTimeout(() => { child.kill("SIGKILL"); }, STOP_GRACE_MS);
        child.once("exit", () => { clearTimeout(killTimer); resolveStop(); });
        child.kill("SIGTERM");
      });

    createInterface({ input: child.stdout }).on("line", (line) => {
      const match = /^SHANNON_LISTENING (\d+)$/.exec(line);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ port: Number(match[1]), child, stop });
        return;
      }
      log(`[server] ${line}`);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      log(`[server] ${line}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening\n${stderrTail.join("\n")}`));
    });
  });
}
