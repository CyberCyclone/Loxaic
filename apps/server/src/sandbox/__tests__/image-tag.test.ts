import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetSandboxImageTag, sandboxImage } from "../container-engine.ts";

/**
 * The image tag is a digest of the build context, so an edit to anything the
 * Dockerfile COPYs changes it and an already-built deployment rebuilds. The
 * digest used to stop at the first subdirectory under sandbox/ (EISDIR
 * thrown into a catch *outside* the loop), silently dropping every later
 * file — the stale-image failure the tag exists to prevent.
 */
describe("the sandbox image tag digests the whole build context", () => {
  let context: string;
  const previous = { context: process.env.SANDBOX_BUILD_CONTEXT, image: process.env.SANDBOX_IMAGE };

  beforeEach(() => {
    context = mkdtempSync(path.join(os.tmpdir(), "loxaic-image-tag-"));
    writeFileSync(path.join(context, "sandbox.Dockerfile"), "FROM scratch\n");
    mkdirSync(path.join(context, "sandbox", "aaa-helpers"), { recursive: true });
    writeFileSync(path.join(context, "sandbox", "aaa-helpers", "lib.py"), "one\n");
    writeFileSync(path.join(context, "sandbox", "zzz-extract.py"), "print(1)\n");
    process.env.SANDBOX_BUILD_CONTEXT = context;
    Reflect.deleteProperty(process.env, "SANDBOX_IMAGE");
    resetSandboxImageTag();
  });

  afterEach(() => {
    if (previous.context === undefined) Reflect.deleteProperty(process.env, "SANDBOX_BUILD_CONTEXT");
    else process.env.SANDBOX_BUILD_CONTEXT = previous.context;
    if (previous.image !== undefined) process.env.SANDBOX_IMAGE = previous.image;
    resetSandboxImageTag();
    rmSync(context, { recursive: true, force: true });
  });

  it("changes when a file sorting after a subdirectory changes", () => {
    const before = sandboxImage();
    writeFileSync(path.join(context, "sandbox", "zzz-extract.py"), "print(2)\n");
    resetSandboxImageTag();
    expect(sandboxImage()).not.toBe(before);
  });

  it("changes when a file inside the subdirectory changes", () => {
    const before = sandboxImage();
    writeFileSync(path.join(context, "sandbox", "aaa-helpers", "lib.py"), "two\n");
    resetSandboxImageTag();
    expect(sandboxImage()).not.toBe(before);
  });

  it("is not the bare fallback tag for a context that has a Dockerfile", () => {
    expect(sandboxImage()).not.toBe("loxaic-sandbox:base");
  });
});
