import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default data directory, matching Electron's `userData` path for this app
 * (appData + productName) — computed without the `electron` module so the
 * headless entry can run under ELECTRON_RUN_AS_NODE, where `app` is
 * unavailable. GUI and headless therefore share the same data by default.
 */
export function defaultDataDir() {
  const name = "Open-Shannon";
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", name);
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), name);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), name);
  }
}

/**
 * Locate the server payload (dist + node_modules + drizzle), web export, and
 * migrations, for both layouts:
 * - packaged: <resources>/server, <resources>/web (src/ lives at
 *   <resources>/app/src, so resources is two levels up from here)
 * - dev (repo checkout): apps/desktop/resources/server (build:server output),
 *   apps/mobile/dist
 */
export function resolveRuntimePaths() {
  // __dirname = .../src/supervisor → app root is two levels up. Packaged,
  // that's <resources>/app; in the repo it's apps/desktop — where the sibling
  // "server" dir is apps/server (the workspace package, no drizzle/ copy), so
  // the payload's migrations copy is what tells the layouts apart.
  const appRoot = path.resolve(__dirname, "../..");
  const packagedResources = path.resolve(appRoot, "..");
  const packagedServer = path.join(packagedResources, "server");
  if (existsSync(path.join(packagedServer, "drizzle/meta/_journal.json"))) {
    return {
      serverDir: packagedServer,
      migrationsDir: path.join(packagedServer, "drizzle"),
      webDistDir: path.join(packagedResources, "web"),
    };
  }
  const repoServer = path.join(appRoot, "resources/server");
  return {
    serverDir: repoServer,
    migrationsDir: path.join(repoServer, "drizzle"),
    webDistDir: path.resolve(appRoot, "../mobile/dist"),
  };
}
