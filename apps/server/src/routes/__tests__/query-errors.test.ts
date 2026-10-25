import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspect, format } from "node:util";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { closeDb, db, eq, findQueryError, isQueryError, isUniqueViolation, pgConstraint, pgErrorCode, sql } from "@loxaic/db";
import { user } from "@loxaic/db/schema";
import { installApiErrorHandler, QUERY_FAILED } from "../errors.ts";
import { describeDbError } from "../../cli/describe-db-error.ts";

/**
 * A failed query never carries a value, wherever it ends up. Since
 * drizzle-orm 0.44 a query error's `message` is the SQL plus every bound
 * parameter, and the Postgres error on its `cause` quotes values in `detail`,
 * in a data exception's message and in a hidden `parameters`. `@loxaic/db`
 * cleans it as drizzle throws it; these cases fail real queries against the
 * real database, so the error has exactly the shape production throws, and
 * they go red if a drizzle upgrade stops routing queries through the cleaner.
 */
const SECRET = "sk-query-error-secret";

/** Everything a log line, a socket message or a JSON body could take from an
 * error: every field, hidden ones and the whole cause chain included. */
const everything = (err: unknown) => `${inspect(err, { depth: 10, showHidden: true })}\n${format(err)}\n${(err as Error).stack ?? ""}`;

async function failing(query: Promise<unknown>): Promise<unknown> {
  return query.then(
    () => { throw new Error("the query was expected to fail"); },
    (err: unknown) => err,
  );
}

/** 22P02 (invalid_text_representation): SECRET is the bound parameter, and
 * Postgres quotes it back in its own message. */
const badInteger = () => failing(db.execute(sql`select ${SECRET}::int`));

const emails: string[] = [];
afterAll(async () => {
  for (const email of emails) await db.delete(user).where(eq(user.email, email));
});

describe("a failed query, as drizzle throws it", () => {
  it("names the SQL and the code, and carries no value", async () => {
    const err = await badInteger();
    expect(isQueryError(err)).toBe(true);
    expect((err as Error).message).toBe("Failed query: select $1::int (code 22P02)");
    expect((err as { params: unknown[] }).params).toEqual([]);
    expect(pgErrorCode(err)).toBe("22P02");
    expect(everything(err)).not.toContain(SECRET);
  });

  it("keeps a unique violation's constraint, not the duplicate key it quotes", async () => {
    const email = `${SECRET}-${uuid()}@example.test`;
    emails.push(email);
    const row = () => ({ id: uuid(), name: "dup", email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(user).values(row());
    const err = await failing(db.insert(user).values(row()));
    expect(isUniqueViolation(err)).toBe(true);
    expect(pgConstraint(err)).toBe("user_email_unique");
    expect(isUniqueViolation(err, "user_email_unique")).toBe(true);
    expect(isUniqueViolation(err, "another_idx")).toBe(false);
    expect(everything(err)).not.toContain(SECRET);
  });

  it("is cleaned inside a transaction too", async () => {
    const err = await failing(db.transaction(async (tx) => { await tx.execute(sql`select ${SECRET}::int`); }));
    expect(pgErrorCode(err)).toBe("22P02");
    expect(everything(err)).not.toContain(SECRET);
  });

  it("is found behind an error that wraps it", async () => {
    const inner = await badInteger();
    const outer = new Error("could not load the thing", { cause: inner });
    expect(findQueryError(outer)).toBe(inner);
    expect(findQueryError(new Error("no query here"))).toBeUndefined();
  });
});

describe("a failed query a route did not catch", () => {
  const logs: string[] = [];
  const app = Fastify({ logger: { level: "error", stream: { write: (line: string) => { logs.push(line); } } } });
  installApiErrorHandler(app);
  app.get("/fails-a-query", async () => { throw await badInteger(); });
  app.get("/fails-because-of-one", async () => { throw new Error("could not load the thing", { cause: await badInteger() }); });
  app.get("/fails-otherwise", () => { throw new Error("a message of our own"); });

  beforeAll(async () => { await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("answers a sentence the client shows, and logs the query without values", async () => {
    const res = await app.inject({ method: "GET", url: "/fails-a-query" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: QUERY_FAILED });
    const log = logs.join("\n");
    expect(log).toContain("select $1::int");
    expect(log).not.toContain(SECRET);
  });

  it("answers the same for an error a failed query caused", async () => {
    const res = await app.inject({ method: "GET", url: "/fails-because-of-one" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: QUERY_FAILED });
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("leaves any other error to Fastify's own handling", async () => {
    const res = await app.inject({ method: "GET", url: "/fails-otherwise" });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ message: string }>().message).toBe("a message of our own");
  });
});

describe("the reset-password CLI's reading of a failure", () => {
  it("says to migrate when the database predates a column", async () => {
    const err = await failing(db.execute(sql`select no_such_column from "user"`));
    expect(describeDbError(err)).toMatch(/has not been migrated for password reset yet/);
  });

  it("prints any other failed query without its values", async () => {
    const text = describeDbError(await badInteger());
    expect(text).toBe("Failed query: select $1::int (code 22P02)");
  });

  // Last: it points the shared client at a closed port, then puts it back.
  it("asks about DATABASE_URL when the database cannot be reached", async () => {
    const saved = process.env.DATABASE_URL;
    await closeDb();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:1/loxaic";
    try {
      const err = await failing(db.execute(sql`select 1`));
      // What the CLI really receives: a query error whose cause is, on a
      // dual-stack localhost, an AggregateError of both refusals.
      expect(isQueryError(err)).toBe(true);
      expect(pgErrorCode(err)).toBe("ECONNREFUSED");
      expect(describeDbError(err)).toMatch(/Is DATABASE_URL set to this server's database\?$/);
    } finally {
      await closeDb();
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
