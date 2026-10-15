/**
 * Encryption at rest for registry login secrets, and the redaction that keeps
 * them out of every error a pull can produce.
 *
 * The blob is the one `inference/provider-secrets.ts` writes (aes-256-gcm,
 * per-blob salt and IV, the same key material, a cached scrypt derive), reused
 * rather than copied a fourth time: it stores one string per row, which is
 * exactly this. Only the error is ours, so a pull can say which login to
 * re-enter.
 */
import { decryptApiKey, encryptApiKey } from "../inference/provider-secrets.ts";

export class RegistryLoginUnreadableError extends Error {
  constructor(registry: string) {
    super(
      `Loxaic can no longer read the stored password for ${registry} — the encryption key has changed. ` +
        "Remove that registry login and add it again.",
    );
    this.name = "RegistryLoginUnreadableError";
  }
}

export function encryptSecret(secret: string): string {
  return encryptApiKey(secret);
}

export function decryptSecret(blob: string, registry: string): string {
  try {
    return decryptApiKey(blob);
  } catch {
    throw new RegistryLoginUnreadableError(registry);
  }
}

/**
 * Scrubs secrets out of text the engine or a registry produced. A registry
 * password can be short, so the floor is GitHub's four characters rather than
 * the providers' eight.
 */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
