import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG, canLaunch, catalogEntry } from "../catalog.ts";

describe("builtin catalog", () => {
  it("ships Brave as a non-dev entry launched from the pinned package", () => {
    const brave = catalogEntry("brave")!;
    expect(brave.dev).toBeUndefined();
    expect(brave.secretKeys.map((k) => k.env)).toEqual(["BRAVE_API_KEY"]);
    const launch = brave.resolveLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/brave-search-mcp-server/);
    expect(existsSync(launch.args[0])).toBe(true);
  });

  it("ships the mock fixture as a dev entry needing no credentials", () => {
    const mock = catalogEntry("mock-dev")!;
    expect(mock.dev).toBe(true);
    expect(mock.secretKeys).toEqual([]);
    const launch = mock.resolveLaunch();
    // node <tsx> <fixture>
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[0]).toMatch(/tsx/);
    expect(launch.args[1]).toMatch(/mock-mcp-server\.ts$/);
    expect(existsSync(launch.args[1])).toBe(true);
  });

  it("reports launchability by probing, so a prod build self-omits", () => {
    for (const entry of BUILTIN_CATALOG) expect(canLaunch(entry)).toBe(true);

    // Stand-in for an install where tsx/the fixture is absent.
    expect(
      canLaunch({
        ...catalogEntry("mock-dev")!,
        resolveLaunch() {
          throw new Error("tsx is not installed");
        },
      }),
    ).toBe(false);
  });

  it("keys are unique and slugs are valid tool namespaces", () => {
    const keys = BUILTIN_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of BUILTIN_CATALOG) expect(entry.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });
});
