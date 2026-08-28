import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  writeFileSync(file, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  return secrets;
}
