import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPassword } from "../reset-password.js";

/**
 * A stand-in for dist/reset-password.js that records what it was given and
 * exits with the code its email asks for. What is held: the email is an
 * argument, the database URL is the one openDatabase resolved, nothing else
 * from this process's environment leaks into the child, the exit code comes
 * back, and the database handle is released whatever happens.
 */
const FAKE_CLI = `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify({
  argv: process.argv.slice(2),
  databaseUrl: process.env.DATABASE_URL,
  envKeys: Object.keys(process.env).sort(),
}));
process.exit(process.argv[2].startsWith("fail") ? 1 : 0);
`;

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.RESET_TEST_SECRET;
});

function fakeEntry() {
  dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-reset-sup-"));
  mkdirSync(path.join(dir, "dist"));
  const entry = path.join(dir, "dist/reset-password.js");
  // No package.json above a temp dir, so Node runs this as CommonJS.
  writeFileSync(entry, FAKE_CLI);
  return entry;
}

const fakeDb = () => ({ url: "postgresql://fake:pw@127.0.0.1:1/loxaic", embedded: true, stop: vi.fn(async () => {}) });

describe("resetPassword", () => {
  it("runs the CLI against this install's database and nothing else", async () => {
    const entry = fakeEntry();
    const db = fakeDb();
    process.env.RESET_TEST_SECRET = "must-not-reach-the-child";
    const code = await resetPassword({ dataDir: dir, email: "alice@example.test", entry, openDatabase: async () => db });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(dir, "dist/report.json"), "utf8"));
    expect(report.argv).toEqual(["alice@example.test"]);
    expect(report.databaseUrl).toBe(db.url);
    expect(report.envKeys).not.toContain("RESET_TEST_SECRET");
    expect(db.stop).toHaveBeenCalledTimes(1);
  });

  it("passes a failure through, and still releases the database", async () => {
    const entry = fakeEntry();
    const db = fakeDb();
    const code = await resetPassword({ dataDir: dir, email: "fail@example.test", entry, openDatabase: async () => db });
    expect(code).toBe(1);
    expect(db.stop).toHaveBeenCalledTimes(1);
  });

  it("says how to build the payload when there is none, before touching the database", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-reset-sup-"));
    const openDatabase = vi.fn();
    await expect(
      resetPassword({ dataDir: dir, email: "a@example.test", entry: path.join(dir, "dist/reset-password.js"), openDatabase }),
    ).rejects.toThrow(/build:server/);
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
