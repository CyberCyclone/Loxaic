import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { account, session, user } from "@loxaic/db/schema";
import { auth } from "../../auth/index.ts";
import { configRoutes } from "../config.ts";

/**
 * `GET /v1/config` through a real Fastify instance.
 *
 * `version` is the one thing this file covers; the sandbox half is exercised
 * elsewhere. It is returned only to a signed-in caller, so one case signs a
 * user up for real — the same way admin-role.test.ts does — and presents the
 * token. See AGENTS.md: vitest shares one process, and pnpm itself sets
 * `npm_package_version` for every script it runs — so both env vars
 * `serverVersion()` reads are saved and restored around every test.
 */
const app = Fastify();
configRoutes(app);

const ENV_KEYS = ["LOXAIC_VERSION", "npm_package_version"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const emails: string[] = [];

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved[key];
  }
});

afterAll(async () => {
  await app.close();
  if (emails.length > 0) {
    const rows = await db.select({ id: user.id }).from(user).where(inArray(user.email, emails));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(session).where(inArray(session.userId, ids));
      await db.delete(account).where(inArray(account.userId, ids));
      await db.delete(user).where(inArray(user.id, ids));
    }
  }
});

interface ConfigBody {
  sandbox: unknown;
  signUpOpen: boolean;
  version?: string | null;
}

const get = async (token?: string): Promise<ConfigBody> =>
  (
    await app.inject({
      method: "GET",
      url: "/v1/config",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  ).json<ConfigBody>();

async function signedInToken(): Promise<string> {
  const email = `config-${uuid()}@example.test`;
  emails.push(email);
  const res = await auth.api.signUpEmail({ body: { email, password: "password123", name: "Config Test" } });
  return res.token ?? "";
}

describe("GET /v1/config", () => {
  it("discloses no version to an unauthenticated caller, whether or not one is set", async () => {
    // An exact build number readable by anyone who can reach the port is
    // the precondition for "which known-vulnerable release is this?", and
    // with Funnel the port can be on the public internet.
    process.env.LOXAIC_VERSION = "1.2.3-beta.4";
    expect((await get()).version).toBeUndefined();
    expect((await get("not-a-real-token")).version).toBeUndefined();
  });

  it("reports the version to a signed-in caller", async () => {
    process.env.LOXAIC_VERSION = "1.2.3-beta.4";
    const body = await get(await signedInToken());
    expect(body.version).toBe("1.2.3-beta.4");
  });

  it("reports null to a signed-in caller when nothing set LOXAIC_VERSION", async () => {
    const body = await get(await signedInToken());
    expect(body.version).toBeNull();
  });

  it("still returns the sandbox status and sign-up policy without a session", async () => {
    const body = await get();
    expect(body.sandbox).toBeTruthy();
    expect(body.signUpOpen).toBe(true);
  });
});

// Referenced so the import is not unused when the cleanup branch is skipped.
void eq;
