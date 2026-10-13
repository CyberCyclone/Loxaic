/**
 * The credential a sandbox shows the egress proxy (`Proxy-Authorization`),
 * naming the conversation it works for and that conversation's owner — whose
 * GitHub token the proxy then uses, and whose workspace decides what may be
 * written (rules.ts).
 *
 * Signed rather than stored: it exists before the sandbox row does (the clone
 * runs inside `provider.create`), and checking it needs no database. It is not
 * a GitHub credential. Whoever holds it gets only what the rules allow, for as
 * long as the conversation exists, and only where the proxy can be reached.
 * The key derives from the same secret the GitHub token is encrypted with, so
 * rotating that secret revokes every credential too.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface EgressIdentity {
  conversationId: string;
  ownerId: string;
}

function key(): Buffer {
  const secret = process.env.MCP_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("the egress proxy needs MCP_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
  return createHash("sha256").update(`loxaic-egress:${secret}`).digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signEgressCredential(identity: EgressIdentity): string {
  const payload = b64(JSON.stringify({ c: identity.conversationId, o: identity.ownerId }));
  const mac = createHmac("sha256", key()).update(payload).digest();
  return `${payload}.${b64(mac)}`;
}

export function verifyEgressCredential(credential: string): EgressIdentity | null {
  const [payload, mac] = credential.split(".");
  if (!payload || !mac || credential.length > 2048) return null;
  const expected = createHmac("sha256", key()).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { c?: unknown; o?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.o !== "string") return null;
    return { conversationId: parsed.c, ownerId: parsed.o };
  } catch {
    return null;
  }
}

/** The credential from a `Proxy-Authorization: Basic …` header (user `sbx`). */
export function credentialFromHeader(header: string | undefined): string | null {
  const m = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}
