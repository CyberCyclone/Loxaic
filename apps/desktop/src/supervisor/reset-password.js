import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { openDatabase as defaultOpenDatabase } from "./index.js";
import { resolveRuntimePaths } from "./paths.js";

/**
 * `--reset-password <email>`: reset a user's password on this install, from
 * the machine it runs on — the way back in for an admin who has forgotten
 * their own, since there is no email reset.
 *
 * Opens this install's database exactly as startStack would (adopting the
 * embedded Postgres when the app or a headless service is already running,
 * so it is safe to run beside one), then runs the bundled
 * `dist/reset-password.js` against it. That program prints the temporary
 * password to stdout, which is inherited here — so this belongs in an
 * interactive shell, never a service unit whose output a journal keeps.
 *
 * The child env is built from scratch, as serverEnv's is: it needs a database
 * URL and nothing else this process holds.
 *
 * Resolves to the child's exit code.
 */
export async function resetPassword({
  dataDir,
  instance = null,
  email,
  log = console.log,
  entry,
  openDatabase = defaultOpenDatabase,
  spawnImpl = spawn,
}) {
  const serverDir = entry ? path.dirname(path.dirname(entry)) : resolveRuntimePaths().serverDir;
  const script = entry ?? path.join(serverDir, "dist/reset-password.js");
  if (!existsSync(script)) {
    throw new Error(`no server payload at ${serverDir} — run \`pnpm --filter @loxaic/desktop build:server\` first`);
  }
  const database = await openDatabase({ dataDir, instance, log });
  try {
    const child = spawnImpl(process.execPath, [script, email], {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: database.url,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    // A no-op when the Postgres was adopted: it belongs to the running app.
    await database.stop().catch(() => undefined);
  }
}
