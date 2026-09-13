import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appVariant } from "../variant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default data directory, matching Electron's `userData` path for this app
 * (appData + productName) — computed without the `electron` module so the
 * headless entry can run under ELECTRON_RUN_AS_NODE, where `app` is
 * unavailable. GUI and headless therefore share the same data by default.
 *
 * Follows the variant's product name, which is what keeps "Loxaic Beta" and
 * "Loxaic" from sharing one embedded Postgres — two apps on one data
 * directory would be two servers fighting over the same database, and a beta
 * that could corrupt the stable install's data is not a beta anyone should
 * run. It matches Electron's own `userData` because electron-builder writes
 * the same `productName` into the packaged package.json (`extraMetadata`),
 * which is where both this and `app.name` now come from.
 */
export function defaultDataDir(name = appVariant().productName) {
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

/**
 * The per-OS tsnet-proxy sidecar binary. It sits beside the server payload
 * in both layouts — resources/{server,tsnet-proxy} in a checkout,
 * Resources/{server,tsnet-proxy} in the packaged app — so it is derived from
 * the same resolution rather than duplicated with its own dev/packaged split.
 * Shared by main.js and headless.js: a headless host has to find it too.
 */
export function tsnetProxyPath() {
  const { serverDir } = resolveRuntimePaths();
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(path.dirname(serverDir), "tsnet-proxy", `tsnet-proxy-${process.platform}-${process.arch}${ext}`);
}
