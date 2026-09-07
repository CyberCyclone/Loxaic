import { db, eq } from "@loxaic/db";
import { githubConnections } from "@loxaic/db/schema";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption-at-rest for the stored GitHub token. Same scheme as
 * `mcp/secrets.ts` (aes-256-gcm, per-blob salt and IV) — a second module
 * rather than importing that one, because this stores exactly one string, not
 * a `Record<string, string>`, and because `mcp/secrets.ts`'s `MCP_ENCRYPTION_KEY`
 * name is specific to MCP in every place a deployment would set it (docs,
 * error messages). The key material and the format are deliberately identical
 * so a deployment doesn't need to reason about two different guarantees.
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
        "MCP_ENCRYPTION_KEY is not set — deriving the GitHub token key from BETTER_AUTH_SECRET. " +
          "Set MCP_ENCRYPTION_KEY so credential encryption survives auth-secret rotation.",
      );
    }
    return fallback;
  }
  throw new Error("Set MCP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) to store a GitHub token");
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(keyMaterial(), salt, 32);
}

function encryptToken(token: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(
    ":",
  );
}

function decryptToken(blob: string): string {
  const [version, saltB64, ivB64, tagB64, ctB64] = blob.split(":");
  if (version !== "v1" || !saltB64 || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Unrecognized GitHub token blob format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(Buffer.from(saltB64, "base64")),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Scrubs a token out of text that might echo it — an error message from the
 * GitHub client, or (in a later stage) git/exec output. */
export function redactToken(text: string, token: string): string {
  return token.length >= 4 ? text.split(token).join("[redacted]") : text;
}

export type GithubConnectionRow = typeof githubConnections.$inferSelect;

export async function getConnection(userId: string): Promise<GithubConnectionRow | null> {
  const row = await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) });
  return row ?? null;
}

/**
 * The only decrypt site outside this module's own tests. Callers that need a
 * live token for an API call or a git clone (a later stage) go through this,
 * never through the raw column.
 */
export async function getOwnerToken(userId: string): Promise<string | null> {
  const row = await getConnection(userId);
  if (!row) return null;
  return decryptToken(row.encryptedToken);
}

export async function upsertConnection(
  userId: string,
  input: { token: string; login: string; name: string | null; email: string | null; scopes: string | null },
): Promise<GithubConnectionRow> {
  const [row] = await db
    .insert(githubConnections)
    .values({
      userId,
      encryptedToken: encryptToken(input.token),
      login: input.login,
      name: input.name,
      email: input.email,
      scopes: input.scopes,
      validatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: githubConnections.userId,
      set: {
        encryptedToken: encryptToken(input.token),
        login: input.login,
        name: input.name,
        email: input.email,
        scopes: input.scopes,
        validatedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Hard delete, not a disabled flag — same choice `routes/mcp.ts` makes for
 * MCP server credentials ("stored credentials must not outlive the user's
 * intent to remove the server"). Disconnecting means the token should no
 * longer exist here, not that it should be remembered-but-off. */
export async function deleteConnection(userId: string): Promise<void> {
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
}

/** What the API ever exposes about a connection — never the token. */
export function toApi(row: GithubConnectionRow) {
  return {
    login: row.login,
    name: row.name,
    email: row.email,
    scopes: row.scopes,
    validatedAt: row.validatedAt.toISOString(),
  };
}
