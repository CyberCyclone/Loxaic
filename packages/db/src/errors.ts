import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

/**
 * Failed queries, made safe where they are made.
 *
 * Since drizzle-orm 0.44 every driver error from a query is wrapped in a
 * `DrizzleQueryError` whose `message` is the SQL followed by every bound
 * parameter (MCP secrets, message bodies, password hashes), with the Postgres
 * error on `cause`. That error carries values too: `detail` ("Failing row
 * contains (…)"), a data exception's message ("invalid input syntax for type
 * integer: \"…\""), and a hidden `parameters` array. Every catch, log line,
 * socket message and tool result downstream would have to remember to clean
 * it, so `installQueryErrorScrub` cleans it once, as drizzle throws it: the
 * message becomes the SQL (placeholders only) and the code, `params` is
 * emptied, and the cause keeps only fields that name things, never values.
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
    // A refused dual-stack `localhost` is an AggregateError, which Node gives
    // the code of its refusals.
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

/** `err` itself or the nearest `cause` that is a failed query. */
export function findQueryError(err: unknown): DrizzleQueryError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof DrizzleQueryError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A failed query's message once cleaned: the SQL (placeholders only) and
 * the code, never the parameters. */
function describeQueryError(err: DrizzleQueryError): string {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err);
  const detail = [code && `code ${code}`, constraint && `constraint ${constraint}`].filter(Boolean).join(", ");
  return `Failed query: ${err.query}${detail ? ` (${detail})` : ""}`;
}

/** The Postgres error fields that name things (which constraint, which
 * column) and never hold a value. `detail`, `where`, `hint` and the hidden
 * `parameters` are left behind. */
const SAFE_DRIVER_FIELDS = ["code", "severity", "constraint_name", "table_name", "column_name", "schema_name", "data_type_name", "routine"];

/** A Postgres error rebuilt from its safe fields. Class 22 (data exception)
 * messages quote the value that failed to convert, so theirs is withheld. */
function scrubDriverError(cause: Error | undefined): Error | undefined {
  if (!cause) return cause;
  const code = (cause as DriverError).code;
  // Connection failures (ECONNREFUSED, ENOTFOUND, …) name a host, not data.
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return cause;
  const clean = new Error(code.startsWith("22") ? `${code}: invalid data (value withheld)` : cause.message);
  clean.name = cause.name;
  for (const field of SAFE_DRIVER_FIELDS) {
    const value = (cause as unknown as Record<string, unknown>)[field];
    if (value !== undefined) Object.assign(clean, { [field]: value });
  }
  return clean;
}

/** Cleans a failed query in place (see the top of this file). */
export function scrubQueryError(err: DrizzleQueryError): DrizzleQueryError {
  const header = `${err.name}: ${err.message}`;
  err.cause = scrubDriverError(err.cause);
  const message = describeQueryError(err);
  err.message = message;
  err.params = [];
  // The stack's first line was formatted from the old message, parameters
  // and all; keep the frames, replace the line.
  if (err.stack?.startsWith(header)) err.stack = `${err.name}: ${message}${err.stack.slice(header.length)}`;
  return err;
}

type QueryWithCache = (this: unknown, queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>;

/**
 * Cleans every failed query before anything can catch it. Every pg-core query
 * (builders, relational queries, `execute`, transactions, the migrator) runs
 * through `PgPreparedQuery.queryWithCache`, which is where drizzle wraps the
 * driver's error. It is internal to drizzle, so `query-errors.test.ts` fails
 * if an upgrade stops routing queries through it.
 */
export function installQueryErrorScrub(): void {
  const proto = PgPreparedQuery.prototype as unknown as { queryWithCache?: QueryWithCache };
  const original = proto.queryWithCache;
  if (typeof original !== "function") throw new Error("drizzle-orm no longer has PgPreparedQuery.queryWithCache; failed queries would carry their parameters");
  proto.queryWithCache = async function (this: unknown, ...args) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      throw err instanceof DrizzleQueryError ? scrubQueryError(err) : err;
    }
  };
}
