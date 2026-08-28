import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tcpOpen } from "./ports.js";

const DB_NAME = "shannon";

/**
 * Reads <databaseDir>/postmaster.pid. Returns { pid, port } or null.
 * Line 1 is the postmaster PID; line 4 is the port (postgres pid-file format).
 */
function readPostmasterPid(databaseDir) {
  try {
    const lines = readFileSync(path.join(databaseDir, "postmaster.pid"), "utf8").split("\n");
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    if (Number.isInteger(pid) && pid > 0) return { pid, port: Number.isInteger(port) ? port : null };
  } catch {
    // No pid file.
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start (or adopt) the embedded Postgres cluster at <dataDir>/postgres.
 *
 * - First run: initdb into the data dir, then create the app database.
 * - Crash recovery: a live postmaster left over from a previous app crash is
 *   adopted (its port comes from postmaster.pid); a stale pid file is removed
 *   before starting fresh.
 *
 * Returns { url, port, stop } — `stop` is a no-op for an adopted cluster we
 * didn't start (stopping it out from under whoever owns it would be worse).
 */
export async function startPostgres({ dataDir, port, password, log }) {
  const databaseDir = path.join(dataDir, "postgres");

  const existing = readPostmasterPid(databaseDir);
  if (existing && processAlive(existing.pid) && existing.port) {
    if (await tcpOpen("127.0.0.1", existing.port)) {
      log(`[postgres] adopting running cluster on port ${existing.port} (pid ${existing.pid})`);
      return {
        url: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${existing.port}/${DB_NAME}`,
        port: existing.port,
        stop: async () => {},
      };
    }
  }
  if (existing) {
    log(`[postgres] removing stale postmaster.pid (pid ${existing.pid} not serving)`);
    rmSync(path.join(databaseDir, "postmaster.pid"), { force: true });
  }

  // Imported lazily, not at module scope: the library calls process.cwd() at
  // load time (for a default databaseDir we never use), which throws EPERM
  // when the app was spawned with a TCC-restricted cwd (e.g. by chromedriver
  // from ~/Documents) — see cwd-guard.js. By exec time the guard has run.
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password,
    persistent: true,
    onLog: (msg) => { log(`[postgres] ${String(msg).trimEnd()}`); },
    onError: (msg) => { log(`[postgres] ${String(msg).trimEnd()}`); },
  });

  const firstRun = !existsSync(path.join(databaseDir, "PG_VERSION"));
  if (firstRun) {
    log("[postgres] first run — initialising cluster (initdb)");
    await pg.initialise();
  }
  await pg.start();
  if (firstRun) {
    await pg.createDatabase(DB_NAME);
  }

  return {
    url: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}`,
    port,
    stop: async () => { await pg.stop(); },
  };
}
