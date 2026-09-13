import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { freePort, tcpOpen } from "../ports.js";
import { loadOrCreateSecrets } from "../secrets.js";
import { defaultDataDir } from "../paths.js";

describe("ports", () => {
  it("freePort returns a bindable port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const srv = net.createServer();
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => srv.close(resolve));
  });

  it("tcpOpen distinguishes open from closed ports", async () => {
    const port = await freePort();
    expect(await tcpOpen("127.0.0.1", port)).toBe(false);
    const srv = net.createServer();
    await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
    expect(await tcpOpen("127.0.0.1", port)).toBe(true);
    await new Promise((resolve) => srv.close(resolve));
  });
});

describe("secrets", () => {
  it("creates once and returns the same values on reload", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-secrets-"));
    const first = loadOrCreateSecrets(dir);
    expect(first.betterAuthSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.pgPassword).toMatch(/^[0-9a-f]{64}$/);
    const second = loadOrCreateSecrets(dir);
    expect(second).toEqual(first);
    const file = path.join(dir, "secrets.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(first);
    // 0600 — the pg password and auth secret must not be world-readable.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("paths", () => {
  it("defaultDataDir ends with the app name and is absolute", () => {
    const dir = defaultDataDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe("Loxaic");
  });

  it("gives each variant its own directory", () => {
    // The two apps must never share one: a single data directory means two
    // servers on one embedded Postgres, and a beta that can corrupt the
    // stable install's database is not a beta anyone should run. The name
    // comes from the packaged productName, which is also what Electron uses
    // for userData, so these agree by construction.
    expect(path.basename(defaultDataDir("Loxaic Beta"))).toBe("Loxaic Beta");
    expect(defaultDataDir("Loxaic Beta")).not.toBe(defaultDataDir("Loxaic"));
  });
});
