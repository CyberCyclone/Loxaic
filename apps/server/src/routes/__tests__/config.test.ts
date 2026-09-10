import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { configRoutes } from "../config.ts";

/**
 * `GET /v1/config` through a real Fastify instance. Unauthenticated and
 * touches no database — `getSandboxStatus()` falls back to env > default
 * when the settings cache was never loaded, which is exactly this test's
 * situation, matching every other test that never boots the full server.
 *
 * `version` is the one thing this file adds coverage for; the sandbox half
 * is exercised elsewhere. See AGENTS.md: vitest shares one process, and pnpm
 * itself sets `npm_package_version` for every script it runs — so both env
 * vars `serverVersion()` reads are saved and restored around every test, not
 * just the one this suite sets.
 */
const app = Fastify();
configRoutes(app);

const ENV_KEYS = ["LOXAIC_VERSION", "npm_package_version"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

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
});

interface ConfigBody {
  sandbox: unknown;
  version: string | null;
}

const get = async (): Promise<ConfigBody> => (await app.inject({ method: "GET", url: "/v1/config" })).json<ConfigBody>();

describe("GET /v1/config", () => {
  it("reports no version when nothing set LOXAIC_VERSION", async () => {
    const body = await get();
    expect(body.version).toBeNull();
  });

  it("reports the version from LOXAIC_VERSION", async () => {
    process.env.LOXAIC_VERSION = "1.2.3-beta.4";
    const body = await get();
    expect(body.version).toBe("1.2.3-beta.4");
  });

  it("still returns the sandbox status alongside it", async () => {
    const body = await get();
    expect(body.sandbox).toBeTruthy();
  });
});
