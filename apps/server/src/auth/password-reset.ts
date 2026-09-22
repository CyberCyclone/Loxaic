import { randomInt, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { account, and, db, eq, session, sql, user } from "@loxaic/db";

/**
 * Resetting a forgotten password, without email.
 *
 * There is no mail transport in this server and none is planned, so a reset
 * is something a person with authority does: an admin from Admin → Users
 * (routes/admin-users.ts), or whoever runs the server, with the reset-password
 * CLI (cli/reset-password.ts) — which is the only way back in for an admin who
 * has forgotten their own. Both call {@link resetUserPassword}.
 *
 * This module is bundled into `dist/reset-password.js`, a separate program
 * that runs with nothing but a DATABASE_URL. It must therefore never import
 * fastify, the server entry, or `./index.ts` (the better-auth instance, which
 * reads BETTER_AUTH_SECRET and the whole auth configuration at load).
 *
 * Hashing uses better-auth/crypto's `hashPassword` directly. That is the
 * function better-auth's own `ctx.context.password.hash` defaults to, so a
 * hash written here verifies at sign-in — for exactly as long as
 * `emailAndPassword.password.hash` stays unset in ./index.ts.
 */

/** No 0/O, 1/l/I: this is read aloud or copied off one screen onto another. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * Sixteen random characters in four dash-separated groups (~94 bits). The
 * dashes are part of the password — they make it easy to read back, and
 * better-auth's 8–128 length bounds hold either way.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 4; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

export class UserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "UserNotFoundError";
  }
}

/** Case-insensitive: people do not remember how they capitalised their email. */
export async function findUserByEmail(
  email: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const rows = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * Replace a user's password with a fresh temporary one, require them to change
 * it at next sign-in, and sign them out of every device — in one transaction,
 * so a reset never half-happens (a new password with live old sessions, or a
 * flag with the old password still working).
 *
 * Returns the temporary password; the caller decides where it goes (one HTTP
 * response, or a terminal). Nothing here logs it, and nothing else may.
 */
export async function resetUserPassword(userId: string): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const hash = await hashPassword(temporaryPassword);
  const now = new Date();
  await db.transaction(async (tx) => {
    const target = (await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1)).at(0);
    if (!target) throw new UserNotFoundError();

    // Mirrors better-auth's own setUserPassword: update the credential account
    // when there is one, otherwise create it, so a user who somehow has none
    // can still be let back in.
    const credential = (
      await tx
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
        .limit(1)
    ).at(0);
    if (credential) {
      await tx.update(account).set({ password: hash, updatedAt: now }).where(eq(account.id, credential.id));
    } else {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx.update(user).set({ mustChangePassword: true, updatedAt: now }).where(eq(user.id, userId));
    // Whoever holds a session may be the reason for the reset.
    await tx.delete(session).where(eq(session.userId, userId));
  });
  return { temporaryPassword };
}

/** Called once POST /api/auth/change-password has succeeded. */
export async function clearMustChangePassword(userId: string): Promise<void> {
  await db
    .update(user)
    .set({ mustChangePassword: false, updatedAt: new Date() })
    .where(and(eq(user.id, userId), eq(user.mustChangePassword, true)));
}
