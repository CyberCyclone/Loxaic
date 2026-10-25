import { describeQueryError, isQueryError, pgErrorCode } from "@loxaic/db";

/** What the reset-password CLI prints for a failure: a hint for the two
 * mistakes an operator can fix, otherwise the error itself (a failed query
 * without its parameters). */
export function describeDbError(err: unknown): string {
  const code = pgErrorCode(err);
  // undefined_column: this database predates the must_change_password column.
  if (code === "42703") {
    return "This database has not been migrated for password reset yet. Start the server once on this version so its migrations run, then try again.";
  }
  const message = isQueryError(err) ? describeQueryError(err) : err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED" || code === "28P01" || code === "3D000") {
    return `${message}\nCould not use the database. Is DATABASE_URL set to this server's database?`;
  }
  return message;
}
