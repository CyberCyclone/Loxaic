import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadOrCreateSecrets } from "./secrets.js";

/**
 * Tries an external database's credentials and, on success, stores the
 * password in `secrets.json`.
 *
 * The point is to fail on the form rather than at boot. A wrong password in
 * config would otherwise surface as a failed migration during startup, after
 * the mode is already committed — with the server's own error, which is
 * accurate but arrives in a place the user cannot act on.
 *
 * The password is written to secrets.json (0600) and never to config.json,
 * which is read by the renderer and safe to log.
 */
export async function testDatabase(input, dataDir) {
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) return { ok: false, reason: "Enter a PostgreSQL connection URL" };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a valid URL" };
  }
  if (!url.protocol.startsWith("postgres")) {
    return { ok: false, reason: `Expected a postgresql:// URL, got ${url.protocol}` };
  }

  const password = typeof input.password === "string" && input.password ? input.password : url.password;
  if (password) url.password = password;

  // postgres.js ships with the server payload, not with the supervisor, so it
  // is imported from there rather than added as a desktop dependency.
  let postgres;
  try {
    ({ default: postgres } = await import("postgres"));
  } catch {
    return { ok: false, reason: "The PostgreSQL client is unavailable in this build" };
  }

  const sql = postgres(url.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }

  if (password) {
    const file = path.join(dataDir, "secrets.json");
    const secrets = loadOrCreateSecrets(dataDir);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ ...secrets, externalDbPassword: password }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  // Echo back the URL without the password — this is what goes in config.json.
  url.password = "";
  return { ok: true, url: url.toString().replace(/:@/, "@") };
}

/** Reads a stored external-database password, if one was saved. */
export function storedDbPassword(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "secrets.json"), "utf8"));
    return parsed.externalDbPassword ?? null;
  } catch {
    return null;
  }
}
