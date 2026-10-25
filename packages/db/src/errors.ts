import { DrizzleQueryError } from "drizzle-orm";

/**
 * Reading a failed query.
 *
 * Since drizzle-orm 0.44 every driver error from a query is wrapped in a
 * `DrizzleQueryError`: the Postgres error (with its SQLSTATE `code` and
 * `constraint_name`) moves to `cause`, and `message` becomes the SQL followed
 * by every bound parameter — MCP secrets, message bodies, whatever the query
 * carried. So never match on a query error's `message`, and never show or log
 * it: read the code here, and describe it with `describeQueryError`.
 */

interface DriverError {
  code?: unknown;
  constraint_name?: unknown;
}

/** The driver's error behind `err`: `err` itself when nothing wrapped it (a
 * connection refused before any query), else the nearest `cause` with a code. */
function driverError(err: unknown): DriverError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const candidate: DriverError = current;
    if (typeof candidate.code === "string") return candidate;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The SQLSTATE (`23505`, `42703`, …) or connection code (`ECONNREFUSED`) of a
 * failed query, wrapped or not. */
export function pgErrorCode(err: unknown): string | undefined {
  return driverError(err)?.code as string | undefined;
}

/** The constraint a failed write ran into (`23505` and friends). */
export function pgConstraint(err: unknown): string | undefined {
  const name = driverError(err)?.constraint_name;
  return typeof name === "string" ? name : undefined;
}

/** True for a unique violation, optionally on one named constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return pgErrorCode(err) === "23505" && (constraint === undefined || pgConstraint(err) === constraint);
}

export function isQueryError(err: unknown): err is DrizzleQueryError {
  return err instanceof DrizzleQueryError;
}

/** A failed query for a log line: the SQL (placeholders only) and the code,
 * never the parameters. */
export function describeQueryError(err: DrizzleQueryError): string {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err);
  const detail = [code && `code ${code}`, constraint && `constraint ${constraint}`].filter(Boolean).join(", ");
  return `Failed query: ${err.query}${detail ? ` (${detail})` : ""}`;
}
