import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateSecrets, readSecrets, updateSecrets } from "../secrets.js";

let dataDir;
beforeEach(() => { dataDir = mkdtempSync(path.join(os.tmpdir(), "loxaic-secrets-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe("secrets.json", () => {
  it("is written whole or not at all, and leaves no temp file behind", () => {
    // A torn write reads back as "missing", which regenerates the Postgres
    // password while the cluster keeps the old one — every later boot then
    // fails to authenticate. Rename is atomic; a plain write is not.
    const first = loadOrCreateSecrets(dataDir);
    updateSecrets(dataDir, { tsnetAuthKey: "tskey-auth-example" });
    expect(readdirSync(dataDir)).toEqual(["secrets.json"]);
    expect(existsSync(path.join(dataDir, "secrets.json.tmp"))).toBe(false);
    const after = readSecrets(dataDir);
    expect(after.tsnetAuthKey).toBe("tskey-auth-example");
    expect(after.betterAuthSecret).toBe(first.betterAuthSecret);
    expect(after.pgPassword).toBe(first.pgPassword);
    expect(statSync(path.join(dataDir, "secrets.json")).mode & 0o777).toBe(0o600);
  });
});
