import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

/**
 * Per-install secrets (better-auth signing secret, Postgres password),
 * generated on first run and persisted at <dataDir>/secrets.json with 0600.
 * Regenerating the auth secret would invalidate every session, so the file is
 * only ever created, never rewritten.
 */
export function loadOrCreateSecrets(dataDir) {
  const file = path.join(dataDir, "secrets.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed.betterAuthSecret && parsed.pgPassword) return parsed;
  } catch {
    // Missing or unreadable — create below.
  }
  const secrets = {
    betterAuthSecret: randomBytes(32).toString("hex"),
    pgPassword: randomBytes(32).toString("hex"),
  };
  mkdirSync(dataDir, { recursive: true });
  writeSecretsFile(file, secrets);
  return secrets;
}

/**
 * Write-to-temp-then-rename, so the file is never observable half-written.
 * This started to matter when secrets.json stopped being write-once: every
 * setMode carrying a tailnet auth key rewrites it, and a torn write reads
 * back as "missing" — which regenerates *both* the auth secret and the
 * Postgres password, while initdb only runs when the data directory is
 * absent. The cluster keeps the old role password and every later boot
 * fails to authenticate, with nothing on screen to say why.
 */
function writeSecretsFile(file, secrets) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Reads whatever secrets exist without creating any — for a read path such
 * as "is an auth key stored?" that must not leave a secrets.json behind on an
 * install that has never been set up.
 */
export function readSecrets(dataDir) {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "secrets.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Adds, replaces, or (with null) removes secrets beside the generated ones.
 * The generated pair is never touched — rewriting the auth secret would sign
 * every session out — so this reads what is there, merges, and writes back
 * with the same 0600.
 *
 * This is the one way an *optional* credential gets in here: an external
 * database password, a tailnet auth key. Neither belongs in config.json,
 * which the renderer reads and which is safe to log.
 */
export function updateSecrets(dataDir, patch) {
  const file = path.join(dataDir, "secrets.json");
  const current = loadOrCreateSecrets(dataDir);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  writeSecretsFile(file, next);
  return next;
}
