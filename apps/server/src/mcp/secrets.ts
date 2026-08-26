import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption-at-rest for MCP server credentials (API keys, auth headers).
 * Blob format: `v1:<saltB64>:<ivB64>:<tagB64>:<ciphertextB64>` — aes-256-gcm
 * with a per-blob random salt (scrypt) and 12-byte IV, so no two blobs share
 * key material and tampering fails the auth tag.
 */

let warnedFallback = false;

function keyMaterial(): string {
  const explicit = process.env.MCP_ENCRYPTION_KEY;
  if (explicit) return explicit;
  const fallback = process.env.BETTER_AUTH_SECRET;
  if (fallback) {
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        "MCP_ENCRYPTION_KEY is not set — deriving the MCP secret key from BETTER_AUTH_SECRET. " +
          "Set MCP_ENCRYPTION_KEY so credential encryption survives auth-secret rotation.",
      );
    }
    return fallback;
  }
  throw new Error("Set MCP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) to store MCP credentials");
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(keyMaterial(), salt, 32);
}

export function encryptSecrets(secrets: Record<string, string>): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(
    ":",
  );
}

export function decryptSecrets(blob: string): Record<string, string> {
  const [version, saltB64, ivB64, tagB64, ctB64] = blob.split(":");
  if (version !== "v1" || !saltB64 || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Unrecognized MCP secret blob format");
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(Buffer.from(saltB64, "base64")), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(plain) as Record<string, string>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP secret blob did not decode to an object");
  }
  return parsed;
}

/** The only thing the API ever exposes about stored secrets: which keys exist. */
export function secretKeys(blob: string | null): string[] {
  if (!blob) return [];
  try {
    return Object.keys(decryptSecrets(blob));
  } catch {
    return [];
  }
}

/**
 * Scrub secret values out of text that may echo them back — spawn errors,
 * HTTP failure bodies, MCP server stderr. Applied to anything stored in
 * lastError or returned by the API.
 */
export function redact(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value.length < 4) continue; // too short to redact meaningfully without mangling text
    out = out.split(value).join("[redacted]");
  }
  return out;
}
