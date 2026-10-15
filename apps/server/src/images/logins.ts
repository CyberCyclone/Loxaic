/**
 * Registry logins: one person's own, or the deployment's (an admin's, for
 * shared images). Never the one for the other, and never anyone else's.
 *
 * Every read is scoped by `owner`: a string is that person, null is the
 * deployment. There is no lookup that takes both, which is what stops a
 * personal image being pulled with the deployment's login or another
 * person's. `authFor` is the only place a secret is decrypted.
 *
 * A login is not checked when it is saved. A refused one says so on the next
 * pull, in a sentence, which is where it matters.
 */
import { and, asc, db, eq, isNull, sql } from "@loxaic/db";
import { registryLogins } from "@loxaic/db/schema";
import { decryptSecret, encryptSecret } from "./login-secrets.ts";
import { serverAddress } from "./reference.ts";

/** A person's id, or null for the deployment's own logins. */
export type LoginOwner = string | null;

export interface RegistryLoginView {
  id: string;
  registry: string;
  username: string;
  updatedAt: string;
}

function ownerIs(owner: LoginOwner) {
  return owner === null ? isNull(registryLogins.ownerId) : eq(registryLogins.ownerId, owner);
}

export function toLoginView(row: typeof registryLogins.$inferSelect): RegistryLoginView {
  return { id: row.id, registry: row.registry, username: row.username, updatedAt: row.updatedAt.toISOString() };
}

export async function listLogins(owner: LoginOwner): Promise<RegistryLoginView[]> {
  const rows = await db
    .select()
    .from(registryLogins)
    .where(ownerIs(owner))
    .orderBy(asc(registryLogins.registry), asc(registryLogins.id));
  return rows.map(toLoginView);
}

/** Adds a login, or replaces the one this owner already has for the registry. */
export async function saveLogin(
  owner: LoginOwner,
  input: { registry: string; username: string; secret: string },
  createdBy: string,
): Promise<RegistryLoginView> {
  const values = {
    ownerId: owner,
    registry: input.registry,
    username: input.username,
    encryptedSecret: encryptSecret(input.secret),
    createdBy,
    updatedAt: new Date(),
  };
  // One statement, against the partial unique index for this kind of owner,
  // so two saves racing for one registry cannot both insert.
  const [row] = await db
    .insert(registryLogins)
    .values(values)
    .onConflictDoUpdate({
      target: owner === null ? [registryLogins.registry] : [registryLogins.ownerId, registryLogins.registry],
      // Postgres infers a partial unique index only when the conflict target
      // repeats its predicate.
      targetWhere: owner === null ? sql`owner_id IS NULL` : sql`owner_id IS NOT NULL`,
      set: { username: values.username, encryptedSecret: values.encryptedSecret, updatedAt: values.updatedAt },
    })
    .returning();
  return toLoginView(row);
}

/** Removes one of this owner's logins. False when there was none. */
export async function deleteLogin(owner: LoginOwner, id: string): Promise<boolean> {
  const removed = await db
    .delete(registryLogins)
    .where(and(eq(registryLogins.id, id), ownerIs(owner)))
    .returning({ id: registryLogins.id });
  return removed.length > 0;
}

export interface PullAuth {
  authconfig: { username: string; password: string; serveraddress: string };
  /** The secret, for redacting whatever the pull produces. */
  secret: string;
}

/**
 * The login this owner has for `registry`, decrypted for one pull, or null
 * when they have none (the pull then goes unauthenticated, which a public
 * image needs and a private one refuses).
 */
export async function authFor(owner: LoginOwner, registry: string): Promise<PullAuth | null> {
  const row = await db.query.registryLogins.findFirst({
    where: and(ownerIs(owner), eq(registryLogins.registry, registry)),
  });
  if (!row) return null;
  const secret = decryptSecret(row.encryptedSecret, registry);
  return {
    authconfig: { username: row.username, password: secret, serveraddress: serverAddress(registry) },
    secret,
  };
}
