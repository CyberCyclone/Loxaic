import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import Fastify from "fastify";
import { db, describeQueryError, isQueryError, isUniqueViolation, pgErrorCode, sql } from "@loxaic/db";
import { installApiErrorHandler } from "../errors.ts";
import { QUERY_FAILED, TURN_FAILED, publicErrorMessage, turnErrorText } from "../../streams/error-text.ts";
import { sendErrorFor } from "../../ws/send-outcomes.ts";
import { describeDbError } from "../../cli/describe-db-error.ts";

/**
 * A failed query, read and reported without its parameters. Since drizzle-orm
 * 0.44 the Postgres error sits on the query error's `cause`, and its `message`
 * is the SQL plus every bound value. Each case fails a real query against the
 * real database, so the error has exactly the shape production throws.
 */
const SECRET = "sk-query-error-secret";

/** 22P02 (invalid_text_representation), with SECRET as the bound parameter. */
async function failedQuery(): Promise<unknown> {
  return db.execute(sql`select ${SECRET}::int`).then(
    () => { throw new Error("the query was expected to fail"); },
    (err: unknown) => err,
  );
}

async function missingColumn(): Promise<unknown> {
  return db.execute(sql`select no_such_column from "user"`).then(
    () => { throw new Error("the query was expected to fail"); },
    (err: unknown) => err,
  );
}

/** A connection refused, as the driver sees it before any query runs. */
async function refusedConnection(): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.connect(1, "127.0.0.1");
    socket.on("error", resolve);
  });
}

const logged = () => errorSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errorSpy.mockClear(); });
afterAll(() => { errorSpy.mockRestore(); });

describe("reading a failed query", () => {
  it("finds the Postgres code behind the wrapper", async () => {
    const err = await failedQuery();
    expect(isQueryError(err)).toBe(true);
    expect((err as Error).message).toContain(SECRET); // what makes the rest necessary
    expect(pgErrorCode(err)).toBe("22P02");
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("reads a code nothing wrapped", async () => {
    expect(pgErrorCode(await refusedConnection())).toBe("ECONNREFUSED");
    expect(pgErrorCode(new Error("no code"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
  });

  it("describes it without its parameters", async () => {
    const err = await failedQuery();
    if (!isQueryError(err)) throw new Error("expected a query error");
    const text = describeQueryError(err);
    expect(text).toContain("Failed query: select $1::int");
    expect(text).toContain("code 22P02");
    expect(text).not.toContain(SECRET);
  });
});

describe("a failed query a route did not catch", () => {
  const logs: string[] = [];
  const app = Fastify({ logger: { level: "error", stream: { write: (line: string) => { logs.push(line); } } } });
  installApiErrorHandler(app);
  app.get("/fails-a-query", async () => { throw await failedQuery(); });
  app.get("/fails-otherwise", () => { throw new Error("a message of our own"); });

  beforeAll(async () => { await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("answers a plain 500 and logs the query without its parameters", async () => {
    const res = await app.inject({ method: "GET", url: "/fails-a-query" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message: QUERY_FAILED });
    expect(res.body).not.toContain(SECRET);
    const log = logs.join("\n");
    expect(log).toContain("Failed query: select $1::int");
    expect(log).not.toContain(SECRET);
  });

  it("leaves any other error to Fastify's own handling", async () => {
    const res = await app.inject({ method: "GET", url: "/fails-otherwise" });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ message: string }>().message).toBe("a message of our own");
  });
});

describe("a failed query a catch answers with", () => {
  it("is replaced, and logged without its parameters", async () => {
    expect(publicErrorMessage(await failedQuery())).toBe(QUERY_FAILED);
    expect(logged()).toContain("Failed query: select $1::int");
    expect(logged()).not.toContain(SECRET);
  });

  it("leaves every other message as it was", () => {
    expect(publicErrorMessage(new Error("That model is not available."))).toBe("That model is not available.");
    expect(publicErrorMessage("plain")).toBe("plain");
  });

  it("never reaches a socket whole", async () => {
    const error = sendErrorFor(await failedQuery(), "ref-1");
    expect(error).toEqual({ type: "error", error: QUERY_FAILED, client_ref: "ref-1" });
    expect(logged()).not.toContain(SECRET);
  });

  it("is logged without its parameters when it ends a turn", async () => {
    expect(turnErrorText(await failedQuery(), "turn failed in c1")).toBe(TURN_FAILED);
    expect(logged()).toContain("turn failed in c1");
    expect(logged()).not.toContain(SECRET);
  });
});

describe("the reset-password CLI's reading of a failure", () => {
  it("says to migrate when the database predates a column", async () => {
    expect(describeDbError(await missingColumn())).toMatch(/has not been migrated for password reset yet/);
  });

  it("asks about DATABASE_URL when the database cannot be reached", async () => {
    expect(describeDbError(await refusedConnection())).toMatch(/Is DATABASE_URL set to this server's database\?$/);
  });

  it("prints any other failed query without its parameters", async () => {
    const text = describeDbError(await failedQuery());
    expect(text).toContain("Failed query: select $1::int");
    expect(text).not.toContain(SECRET);
  });
});
