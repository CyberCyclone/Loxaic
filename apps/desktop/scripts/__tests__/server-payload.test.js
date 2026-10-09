import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAYLOAD_KEEP, pruneToPayload } from "../server-payload.mjs";

/**
 * `pnpm deploy` copies every file in apps/server that npm would not ignore, and a checkout that
 * has run the dev server holds its downloaded models in `llama/` and users' files in `uploads/`.
 * One Gemma is 17 GB: it was copied into the payload and again into the .app, and would have
 * shipped in a locally built installer. CI has neither directory, so nothing there could notice.
 */
function payload(entries) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "payload-"));
  for (const name of entries) {
    const full = path.join(dir, name);
    if (name.endsWith(".json") || name.endsWith(".ts")) writeFileSync(full, "x");
    else {
      mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, "file"), "x");
    }
  }
  return dir;
}

describe("pruneToPayload", () => {
  it("removes the dev server's models and uploads, which deploy copies along", () => {
    const dir = payload(["dist", "node_modules", "package.json", "llama", "uploads"]);
    try {
      expect(pruneToPayload(dir).sort()).toEqual(["llama", "uploads"]);
      expect(readdirSync(dir).sort()).toEqual(["dist", "node_modules", "package.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes what nobody has thought of yet, which is the point of an allowlist", () => {
    const dir = payload(["dist", "node_modules", "package.json", "some-future-cache", "stray.ts", "src", "apps", "test-fixtures"]);
    try {
      pruneToPayload(dir);
      expect(readdirSync(dir).sort()).toEqual([...PAYLOAD_KEEP].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps everything the server runs from, untouched", () => {
    const dir = payload(["dist", "node_modules", "package.json"]);
    try {
      expect(pruneToPayload(dir)).toEqual([]);
      expect(existsSync(path.join(dir, "dist/file"))).toBe(true);
      expect(existsSync(path.join(dir, "node_modules/file"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes a link, never what it points at", () => {
    const dir = payload(["dist", "node_modules", "package.json"]);
    const outside = mkdtempSync(path.join(os.tmpdir(), "outside-"));
    writeFileSync(path.join(outside, "model.gguf"), "x");
    try {
      symlinkSync(outside, path.join(dir, "llama"));
      expect(pruneToPayload(dir)).toEqual(["llama"]);
      expect(existsSync(path.join(outside, "model.gguf"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
