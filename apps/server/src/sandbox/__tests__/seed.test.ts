import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostProvider } from "../host-provider.ts";
import { seedSandbox } from "../seed.ts";

describe("seedSandbox", () => {
  let sandboxRoot: string;
  let fixtureDir: string;

  beforeEach(() => {
    sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "loxaic-seed-sandbox-"));
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "loxaic-seed-fixture-"));
    process.env.SANDBOX_HOST_ROOT = sandboxRoot;
  });

  afterEach(() => {
    delete process.env.SANDBOX_HOST_ROOT;
    rmSync(sandboxRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("copies every file, including nested ones, into the sandbox's workdir", async () => {
    writeFileSync(path.join(fixtureDir, "INSTRUCTIONS.md"), "build the thing\n");
    mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
    writeFileSync(path.join(fixtureDir, "src", "index.ts"), "export const x = 1;\n");

    const handle = await getHostProvider().create("user-1", {});
    await seedSandbox(handle, fixtureDir);

    expect(readFileSync(path.join(handle.workdir, "INSTRUCTIONS.md"), "utf8")).toBe("build the thing\n");
    expect(readFileSync(path.join(handle.workdir, "src", "index.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  it("is a no-op on an empty source directory", async () => {
    const handle = await getHostProvider().create("user-1", {});
    await expect(seedSandbox(handle, fixtureDir)).resolves.toBeUndefined();
    await expect(handle.fileTree(handle.workdir)).resolves.toEqual([]);
  });

  it("overwrites a file the sandbox already had at that path", async () => {
    const handle = await getHostProvider().create("user-1", {});
    await handle.writeFile(path.join(handle.workdir, "README.md"), "old content");

    writeFileSync(path.join(fixtureDir, "README.md"), "new content");
    await seedSandbox(handle, fixtureDir);

    expect(readFileSync(path.join(handle.workdir, "README.md"), "utf8")).toBe("new content");
  });
});
