import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which of the two desktop apps this process is: Loxaic, or Loxaic Beta.
 *
 * Read from the packaged package.json, which electron-builder writes
 * `productName` and `loxaicVariant` into via `extraMetadata` (see
 * electron-builder.config.cjs). That file is the only thing the running app
 * can consult — `LOXAIC_VARIANT` exists at *package* time, not at run time —
 * and `asar: false` is what makes it a plain readable file.
 *
 * Deliberately imports no electron: the headless entry runs under
 * ELECTRON_RUN_AS_NODE where `app` is unavailable, and both entry points need
 * the same answer about which data directory to use.
 *
 * A repo checkout has neither field, and resolves to production — which is
 * right: `pnpm dev` is the stable app, and a developer should not have their
 * data directory move because a field is absent.
 */
export function appVariant(pkgPath = defaultPkgPath()) {
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    // An unreadable package.json is not a reason to refuse to start; it is a
    // reason to be the ordinary app.
  }
  const name = parsed.loxaicVariant === "beta" ? "beta" : "production";
  return {
    name,
    productName: typeof parsed.productName === "string" ? parsed.productName : "Loxaic",
    /** Whether this build follows prereleases. Fixed at package time. */
    prerelease: name === "beta",
  };
}

function defaultPkgPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
}
