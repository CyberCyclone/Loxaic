import { closeDb } from "@loxaic/db";
import { findUserByEmail, resetUserPassword } from "../auth/password-reset.ts";

/**
 * reset-password <email>
 *
 * Resets a user's password from the machine that hosts the server — the way
 * back in for an admin who has forgotten their own, since there is no email
 * reset. Needs only DATABASE_URL; it never loads the server or the auth
 * configuration. Run from an interactive shell: the temporary password goes to
 * stdout, so running it from a service unit would leave it in a journal.
 *
 *   dev:       pnpm --filter @loxaic/server reset-password alice@example.com
 *   docker:    docker compose exec server node dist/reset-password.js alice@example.com
 *   desktop:   Loxaic --headless --reset-password alice@example.com
 */

const USAGE = "Usage: reset-password <email>\n";

function describe(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  // undefined_column: this database predates the must_change_password column.
  if (code === "42703") {
    return "This database has not been migrated for password reset yet. Start the server once on this version so its migrations run, then try again.";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED" || code === "28P01" || code === "3D000") {
    return `${message}\nCould not use the database. Is DATABASE_URL set to this server's database?`;
  }
  return message;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const email = args[0];
  if (!email || email === "--help" || email === "-h" || args.length > 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const found = await findUserByEmail(email);
    if (!found) {
      process.stderr.write(`No user with the email ${email}.\n`);
      return 1;
    }
    const { temporaryPassword } = await resetUserPassword(found.id);
    process.stdout.write(
      `Temporary password for ${found.email}: ${temporaryPassword}\n` +
        "Every device they were signed in on has been signed out. They must sign in with this password once and choose a new one before they can do anything else.\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${describe(err)}\n`);
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

// exitCode, not process.exit(): stdout is asynchronous on a pipe — which both
// `pnpm --filter` and `docker compose exec -T` are — and exit() drops what has
// not been written yet. The reset is already committed by then, so the line
// being dropped is the only copy of the temporary password. The pool is
// closed in main's finally, so nothing keeps the loop alive.
void main().then((code) => {
  process.exitCode = code;
});
