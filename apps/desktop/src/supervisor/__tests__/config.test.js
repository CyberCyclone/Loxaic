import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advertiseUrlFor,
  bindHostFor,
  buildConfig,
  configPath,
  defaultHostName,
  firstLanAddress,
  hostSettingsView,
  loadConfig,
  saveConfig,
} from "../config.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "loxaic-config-test-"));
}

describe("loadConfig", () => {
  it("returns null for an install that has never been configured", () => {
    // Absence is the *only* first-run signal there is — the GUI opens
    // onboarding on exactly this.
    expect(loadConfig(tmpDir())).toBeNull();
  });

  it("returns null rather than throwing on a corrupt file", () => {
    const dir = tmpDir();
    writeFileSync(configPath(dir), "{ not json");
    expect(loadConfig(dir)).toBeNull();
  });

  it("returns null for a future version this build cannot read", () => {
    const dir = tmpDir();
    writeFileSync(configPath(dir), JSON.stringify({ version: 99, mode: "host", instanceId: "x" }));
    expect(loadConfig(dir)).toBeNull();
  });

  it("returns null for an unknown mode", () => {
    const dir = tmpDir();
    writeFileSync(configPath(dir), JSON.stringify({ version: 1, mode: "banana", instanceId: "x" }));
    expect(loadConfig(dir)).toBeNull();
  });

  it("round-trips a saved config, 0600", () => {
    const dir = tmpDir();
    const saved = saveConfig(dir, buildConfig({ mode: "solo" }));
    expect(loadConfig(dir)).toEqual(saved);
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("buildConfig", () => {
  it("mints an instanceId and defaults the host name to the machine's", () => {
    const config = buildConfig({ mode: "host" });
    expect(config.instanceId).toMatch(/[0-9a-f-]{36}/);
    expect(config.host.name).toBe(defaultHostName());
  });

  it("carries the instanceId across a mode change", () => {
    // The id is this machine's identity in the hosts table. Regenerating it on
    // a Solo->Host switch would register the same machine twice.
    const solo = buildConfig({ mode: "solo" });
    const host = buildConfig({ mode: "host" }, solo);
    expect(host.instanceId).toBe(solo.instanceId);
  });

  it("keeps a previously chosen host name when the new input omits one", () => {
    const first = buildConfig({ mode: "host", host: { name: "GPU Box" } });
    const second = buildConfig({ mode: "host" }, first);
    expect(second.host.name).toBe("GPU Box");
  });

  it("forces solo to loopback whatever bind the caller asked for", () => {
    // Solo means "this machine only" — a solo instance listening on the LAN
    // would be a host that never registered as one.
    const config = buildConfig({ mode: "solo", host: { bind: "lan" } });
    expect(config.host.bind).toBe("localhost");
    expect(bindHostFor(config.host)).toBe("127.0.0.1");
  });

  it("does not let solo inherit a previous host's advertiseUrl", () => {
    // Solo forces a loopback bind, but advertiseUrl outranks the bind when
    // deriving BETTER_AUTH_URL — so an inherited external address would point
    // sign-in at somewhere nothing is listening, and registerHost would keep
    // publishing that dead address into the cluster.
    const host = buildConfig({ mode: "host", host: { advertiseUrl: "https://gpu-box.tail.ts.net" } });
    expect(host.host.advertiseUrl).toBe("https://gpu-box.tail.ts.net");
    const solo = buildConfig({ mode: "solo" }, host);
    expect(solo.host.advertiseUrl).toBeUndefined();
  });

  it("still lets a host keep its previous advertiseUrl when the new input omits one", () => {
    const first = buildConfig({ mode: "host", host: { advertiseUrl: "https://gpu-box.tail.ts.net" } });
    const second = buildConfig({ mode: "host" }, first);
    expect(second.host.advertiseUrl).toBe("https://gpu-box.tail.ts.net");
  });

  it("binds a host to all interfaces", () => {
    expect(bindHostFor(buildConfig({ mode: "host" }).host)).toBe("0.0.0.0");
  });

  it("rejects client mode with no host URL, rather than storing an unusable config", () => {
    expect(() => buildConfig({ mode: "client" })).toThrow(/host's URL/);
  });

  it("normalises a client's trailing slash", () => {
    const config = buildConfig({ mode: "client", client: { hostUrl: "http://box.local:4100/" } });
    expect(config.client.hostUrl).toBe("http://box.local:4100");
  });

  it("rejects an unknown mode", () => {
    expect(() => buildConfig({ mode: "peer" })).toThrow(/Unknown instance mode/);
  });

  it("caps a host name rather than storing an unbounded string", () => {
    const config = buildConfig({ mode: "host", host: { name: "x".repeat(500) } });
    expect(config.host.name).toHaveLength(64);
  });

  it("rejects a non-numeric port rather than storing NaN", () => {
    expect(() => buildConfig({ mode: "host", host: { port: "banana" } })).toThrow(/Port must be/);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => buildConfig({ mode: "host", host: { port: 80 } })).toThrow(/Port must be/);
    expect(() => buildConfig({ mode: "host", host: { port: 70000 } })).toThrow(/Port must be/);
    expect(() => buildConfig({ mode: "host", host: { port: 4100.5 } })).toThrow(/Port must be/);
  });

  it("rejects an unknown bind value for a host", () => {
    expect(() => buildConfig({ mode: "host", host: { bind: "everywhere" } })).toThrow(/Bind must be/);
  });

  it("rejects an advertise URL with a path, query, or fragment", () => {
    expect(() => buildConfig({ mode: "host", host: { advertiseUrl: "https://x.example.com/app" } })).toThrow(
      /must not include a path/,
    );
    expect(() => buildConfig({ mode: "host", host: { advertiseUrl: "https://x.example.com/?a=1" } })).toThrow(
      /must not include a path/,
    );
  });

  it("rejects an advertise URL that isn't http(s)", () => {
    expect(() => buildConfig({ mode: "host", host: { advertiseUrl: "not a url" } })).toThrow(/must be a full URL/);
    expect(() => buildConfig({ mode: "host", host: { advertiseUrl: "ftp://x.example.com" } })).toThrow(
      /must start with http/,
    );
  });

  it("normalises a trailing slash on an otherwise bare advertise URL", () => {
    const config = buildConfig({ mode: "host", host: { advertiseUrl: "https://x.example.com/" } });
    expect(config.host.advertiseUrl).toBe("https://x.example.com");
  });
});

describe("hostSettingsView", () => {
  it("returns null for no host config", () => {
    expect(hostSettingsView(null)).toBeNull();
    expect(hostSettingsView(undefined)).toBeNull();
  });

  it("never leaks the database URL or password", () => {
    const config = buildConfig({
      mode: "host",
      host: { name: "GPU Box", port: 4100, bind: "lan", db: { kind: "external", url: "postgres://u:p@host/db" } },
    });
    const view = hostSettingsView(config.host);
    expect(view).toEqual({
      name: "GPU Box",
      port: 4100,
      bind: "lan",
      advertiseUrl: null,
      db: { kind: "external" },
    });
  });
});

describe("advertiseUrlFor", () => {
  it("prefers an explicit advertise URL over anything derived", () => {
    // A reverse proxy or tailnet name the user knows better than we do.
    expect(advertiseUrlFor({ advertiseUrl: "https://loxaic.example.ts.net/", port: 4100 })).toBe(
      "https://loxaic.example.ts.net",
    );
  });

  it("uses loopback for a localhost-bound instance", () => {
    expect(advertiseUrlFor({ bind: "localhost", port: 4100 })).toBe("http://localhost:4100");
  });

  it("uses a routable address for a LAN-bound host", () => {
    // This is what BETTER_AUTH_URL is derived from: a host serving LAN
    // clients while advertising localhost rejects every one of them.
    // Skipped on a machine with no non-internal interface (CI containers),
    // where falling back to localhost is the correct answer, not a failure.
    const lan = firstLanAddress();
    const url = advertiseUrlFor({ bind: "lan", port: 4100 });
    if (!lan) {
      expect(url).toBe("http://localhost:4100");
      return;
    }
    expect(url).toBe(`http://${lan}:4100`);
  });
});
