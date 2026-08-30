import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { probeEngines, resetEngineCache, __candidatesForTest } from "../container-provider.ts";
import { resetServerSettingsCache } from "../../settings.ts";

const ENV_KEYS = ["CONTAINER_SOCKET", "XDG_RUNTIME_DIR"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  resetServerSettingsCache();
  resetEngineCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  resetServerSettingsCache();
  resetEngineCache();
});

const sockets = () => __candidatesForTest().map((c) => c.socketPath);

describe("engine candidate selection", () => {
  it("auto keeps the historical order: docker default, podman, then colima", () => {
    const home = os.homedir();
    expect(sockets()).toEqual([
      undefined, // dockerode's own default, /var/run/docker.sock
      path.join(home, ".local/share/containers/podman/machine/podman.sock"),
      path.join(home, ".colima/default/docker.sock"),
    ]);
  });

  it("includes the rootless podman socket only when XDG_RUNTIME_DIR is set", () => {
    expect(sockets()).not.toContain("/run/user/1000/podman/podman.sock");
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(sockets()).toContain("/run/user/1000/podman/podman.sock");
  });

  it("CONTAINER_SOCKET pins exactly one socket and skips discovery", () => {
    process.env.CONTAINER_SOCKET = "/tmp/pinned.sock";
    expect(sockets()).toEqual(["/tmp/pinned.sock"]);
  });

  it("labels the pinned socket by its path, so the failure message names it", () => {
    process.env.CONTAINER_SOCKET = "/tmp/pinned.sock";
    expect(__candidatesForTest()[0].label).toBe("/tmp/pinned.sock");
  });
});

describe("probeEngines", () => {
  it("reports both engines regardless of which is installed", async () => {
    const probes = await probeEngines();
    expect(probes.map((p) => p.id).sort()).toEqual(["docker", "podman"]);
    // Availability depends on the developer's machine, so only the shape is
    // asserted here; a live engine is verified by hand (see the PR).
    for (const probe of probes) {
      expect(typeof probe.available).toBe("boolean");
      if (probe.available) {
        expect(typeof probe.socketPath).toBe("string");
      } else {
        expect(probe.socketPath).toBeUndefined();
      }
    }
  });

  it("ignores the configured pin — it answers what could be used, not what is", async () => {
    process.env.CONTAINER_SOCKET = "/tmp/definitely-not-a-socket.sock";
    const probes = await probeEngines();
    expect(probes).toHaveLength(2);
  });
});
