import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverVersion } from "../version.ts";

const ENV_KEYS = ["LOXAIC_VERSION", "npm_package_version"] as const;

/** vitest shares one process across test files, so a stray LOXAIC_VERSION
 * left in the ambient environment (or npm_package_version, which pnpm sets
 * for every script it runs — including `vitest run` itself) must not leak
 * into these assertions, and these must not leak into anyone else's. */
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

describe("serverVersion", () => {
  it("is null when neither env var is set", () => {
    expect(serverVersion()).toBeNull();
  });

  it("prefers LOXAIC_VERSION — the desktop supervisor's own stamp", () => {
    process.env.LOXAIC_VERSION = "1.2.3";
    process.env.npm_package_version = "0.0.0";
    expect(serverVersion()).toBe("1.2.3");
  });

  it("falls back to npm_package_version — what `pnpm dev`/`pnpm start` set", () => {
    process.env.npm_package_version = "0.0.0";
    expect(serverVersion()).toBe("0.0.0");
  });

  it("treats an empty LOXAIC_VERSION as unset, not as a version", () => {
    // `ENV LOXAIC_VERSION=$LOXAIC_VERSION` in the Docker image is set to ""
    // when no --build-arg was passed — Docker has no way to leave it truly
    // unset — and this is what keeps that image honestly reporting null
    // instead of an empty-string "version".
    process.env.LOXAIC_VERSION = "";
    process.env.npm_package_version = "0.0.0";
    expect(serverVersion()).toBe("0.0.0");
  });

  it("is null when both are empty strings", () => {
    process.env.LOXAIC_VERSION = "";
    process.env.npm_package_version = "";
    expect(serverVersion()).toBeNull();
  });
});
