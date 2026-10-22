import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { parseLimits, readLimits } from "../store.ts";
import {
  createSandboxContainer,
  KvmMissingError,
  kvmGroup,
} from "../../sandbox/container-engine.ts";
import { sandboxImage } from "../../sandbox/container-provider.ts";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";

/**
 * The KVM switch on shared images (#320): the only device a sandbox can be
 * given. Pinned here: an admin's limits carry it and nothing else does, the
 * container gets exactly /dev/kvm and its group with every other restriction
 * unchanged, and a host without the device says so in words.
 */

describe("an image's kvm limit", () => {
  it("is off unless an admin turns it on", () => {
    expect(parseLimits({}).kvm).toBe(false);
    expect(parseLimits({ kvm: true }).kvm).toBe(true);
    expect(parseLimits({ memoryMb: 1024, kvm: false }).kvm).toBe(false);
  });

  it("survives saving the sizes, which leave it out", () => {
    const current = { memoryMb: 16_384, cpus: 8, pids: 8192, kvm: true };
    expect(parseLimits({ memoryMb: 8192, cpus: 4, pids: 4096 }, current)).toEqual({ memoryMb: 8192, cpus: 4, pids: 4096, kvm: true });
    expect(parseLimits({ kvm: false }, current)).toEqual({ ...current, kvm: false });
  });

  it("refuses anything but true or false", () => {
    expect(() => parseLimits({ kvm: "yes" })).toThrow("kvm must be true or false.");
    expect(() => parseLimits({ kvm: 1 })).toThrow("kvm must be true or false.");
  });

  it("reads as off from a row stored before it existed", () => {
    expect(readLimits({ memoryMb: 512, cpus: 1, pids: 100 })?.kvm).toBe(false);
    expect(readLimits({ memoryMb: 512, cpus: 1, pids: 100, kvm: true })?.kvm).toBe(true);
  });
});

/** A stand-in engine that records what it was asked to create, and can fail
 * the start the way Docker does for a missing device. */
function fakeDocker(failStart?: string) {
  const seen: { create?: Record<string, unknown>; removed: boolean } = { removed: false };
  const container = {
    id: randomUUID(),
    putArchive: () => Promise.resolve(),
    start: () => (failStart ? Promise.reject(new Error(failStart)) : Promise.resolve()),
    remove: () => {
      seen.removed = true;
      return Promise.resolve();
    },
  };
  const docker = {
    createContainer: (opts: Record<string, unknown>) => {
      seen.create = opts;
      return Promise.resolve(container);
    },
    getContainer: () => container,
  } as unknown as Docker;
  return { docker, seen };
}

function hostConfig(seen: { create?: Record<string, unknown> }): Record<string, unknown> {
  return (seen.create?.HostConfig ?? {}) as Record<string, unknown>;
}

describe("a container from an image with KVM", () => {
  const image = { ref: "registry.test/dev@sha256:" + "a".repeat(64), home: { uid: 1001, gid: 1001 } };

  it("gets /dev/kvm and its group, and keeps every other restriction", async () => {
    const { docker, seen } = fakeDocker();
    await createSandboxContainer(docker, { userId: "u", network: false, image: { ...image, kvm: true } });
    const config = hostConfig(seen);
    expect(config.Devices).toEqual([{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }]);
    const gid = kvmGroup();
    if (gid === null) expect(config.GroupAdd).toBeUndefined();
    else expect(config.GroupAdd).toEqual([String(gid)]);
    expect(config.CapDrop).toEqual(["ALL"]);
    expect(config.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(config.Privileged).toBeUndefined();
    expect(config.CapAdd).toBeUndefined();
  });

  it("gets no device at all without it", async () => {
    const { docker, seen } = fakeDocker();
    await createSandboxContainer(docker, { userId: "u", network: false, image });
    expect(hostConfig(seen).Devices).toBeUndefined();
    expect(hostConfig(seen).GroupAdd).toBeUndefined();
  });

  it("says in words when the engine's host has no /dev/kvm, and leaves no container", async () => {
    const { docker, seen } = fakeDocker(
      '(HTTP code 500) server error - error gathering device information while adding custom device "/dev/kvm": no such file or directory',
    );
    await expect(
      createSandboxContainer(docker, { userId: "u", network: false, image: { ...image, kvm: true } }),
    ).rejects.toBeInstanceOf(KvmMissingError);
    expect(seen.removed).toBe(true);
  });

  it("passes any other start failure through as itself", async () => {
    const { docker } = fakeDocker("(HTTP code 500) server error - no space left on device");
    await expect(
      createSandboxContainer(docker, { userId: "u", network: false, image: { ...image, kvm: true } }),
    ).rejects.toThrow("no space left on device");
  });
});

const dockerReady = await sandboxImageReady();

describe.skipIf(!dockerReady)("against the real engine", () => {
  it("either hands the sandbox a working /dev/kvm or refuses in words", async () => {
    const Dockerode = (await import("dockerode")).default;
    const docker = new Dockerode();
    // Loxaic's own image stands in for a shared one: the custom-image path
    // only overrides its entrypoint.
    const attempt = createSandboxContainer(docker, {
      userId: `test-kvm-${randomUUID()}`,
      network: false,
      image: { ref: sandboxImage(), kvm: true },
    });
    let handle: Awaited<typeof attempt>;
    try {
      handle = await attempt;
    } catch (err) {
      // Docker Desktop and any engine without the device: this is the message
      // the person sees.
      expect(err).toBeInstanceOf(KvmMissingError);
      return;
    }
    try {
      const check = await handle.exec(["test", "-c", "/dev/kvm"], { workdir: "/" });
      expect(check.exitCode).toBe(0);
    } finally {
      await handle.destroy();
    }
  }, 60_000);
});
