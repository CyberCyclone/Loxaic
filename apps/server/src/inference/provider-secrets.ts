import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption-at-rest for a provider's API key, and the redaction that keeps it
 * out of everything a key-bearing request can echo back.
 *
 * Same blob format and key material as `github/connection.ts` and
 * `mcp/secrets.ts` (aes-256-gcm, per-blob salt and IV) — a third module for
 * the same reason there is a second: this stores exactly one string per row,
 * and a deployment should not have to reason about a different guarantee for
 * each kind of credential.
 *
 * The derive is cached per salt, like `github/connection.ts`'s and unlike
 * `mcp/secrets.ts`'s. That is not a preference: a provider key is decrypted on
 * the path of every inference request, and scrypt at the default parameters
 * costs ~16 MB and tens of milliseconds *synchronously* — uncached, it would
 * stall the event loop, and so every other user's stream, once per turn.
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
        "MCP_ENCRYPTION_KEY is not set — deriving the provider API key encryption key from BETTER_AUTH_SECRET. " +
          "Set MCP_ENCRYPTION_KEY so credential encryption survives auth-secret rotation.",
      );
    }
    return fallback;
  }
  throw new Error("Set MCP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) to store a provider API key");
}

const keyCache = new Map<string, Buffer>();
const KEY_CACHE_MAX = 256;

function deriveKey(salt: Buffer): Buffer {
  const id = salt.toString("base64");
  const cached = keyCache.get(id);
  if (cached) return cached;
  const key = scryptSync(keyMaterial(), salt, 32);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(id, key);
  return key;
}

/**
 * The stored key exists but cannot be decrypted — the derived key no longer
 * matches the blob, almost always because an operator took this module's own
 * advice and set `MCP_ENCRYPTION_KEY` after the key was written under
 * `BETTER_AUTH_SECRET`. Its own error so a provider can say "re-enter the API
 * key" instead of failing every turn with a bare 500, and so the admin list
 * can keep showing which provider it is.
 */
export class ProviderKeyUnreadableError extends Error {
  constructor(providerName: string) {
    super(
      `Loxaic can no longer read the stored API key for "${providerName}" — the encryption key has changed. ` +
        "Re-enter the key in Settings → Model providers.",
    );
    this.name = "ProviderKeyUnreadableError";
  }
}

export function encryptApiKey(key: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(
    ":",
  );
}

export function decryptApiKey(blob: string): string {
  const [version, saltB64, ivB64, tagB64, ctB64] = blob.split(":");
  if (version !== "v1" || !saltB64 || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Unrecognized provider API key blob format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(Buffer.from(saltB64, "base64")),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Scrub credentials out of text a provider produced.
 *
 * This is not defence in depth, it is the only defence: whatever
 * `streamCompletion` throws is persisted on the message row and re-served to
 * everyone on the conversation, shared viewers included — and an upstream 401
 * body routinely echoes part of the key it rejected ("Incorrect API key
 * provided: sk-…abcd"). Custom header values are scrubbed too, since an admin
 * may well have put a second credential in one.
 *
 * Values under 8 characters are skipped: a short one is far more likely to
 * occur in ordinary prose than to be a real credential, and replacing every
 * occurrence of it would mangle the message while protecting nothing.
 */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
