import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What a model is measured against, taken apart: free now, what our unpinned
 * models would give back, what pinned ones and other programs hold. The router
 * is mocked to a two-GPU box shaped like the one this was written for — two
 * 30 GB cards, another program holding 26 GB of the first.
 */

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const view = {
  devices: [
    { name: "Vulkan0", description: "V620", totalBytes: 30 * GiB, freeBytes: 4 * GiB },
    { name: "Vulkan1", description: "V620", totalBytes: 30 * GiB, freeBytes: 30 * GiB },
  ],
  activeDevices: ["Vulkan0", "Vulkan1"] as string[] | "none",
};
let cpu = false;

vi.mock("../router.ts", () => ({
  offloadMemory: () => {
    if (cpu) return { bytes: 64 * GiB, cpu: true };
    const active = view.activeDevices === "none" ? [] : view.activeDevices;
    return { bytes: view.devices.filter((d) => active.includes(d.name)).reduce((n, d) => n + d.freeBytes, 0), cpu: false };
  },
  runtimeView: () => view,
  remeasureDevices: () => Promise.resolve(),
  routerEndpoint: () => null,
  routerModelStatuses: () => Promise.resolve(new Map()),
}));

const { availableMemory, __setLoadedFootprintsForTest } = await import("../memory.ts");

afterEach(() => {
  cpu = false;
  view.activeDevices = ["Vulkan0", "Vulkan1"];
  __setLoadedFootprintsForTest([]);
});

describe("availableMemory", () => {
  it("adds both GPUs' free memory, and says the rest is other programs", () => {
    const mem = availableMemory();
    expect(mem.bytes).toBe(34 * GiB);
    expect(mem.breakdown).toEqual({
      freeBytes: 34 * GiB,
      reclaimableBytes: 0,
      pinnedBytes: 0,
      otherBytes: 26 * GiB,
      totalBytes: 60 * GiB,
      deviceCount: 2,
    });
  });

  it("counts only the GPUs in use", () => {
    view.activeDevices = ["Vulkan1"];
    const mem = availableMemory();
    expect(mem.bytes).toBe(30 * GiB);
    expect(mem.breakdown?.deviceCount).toBe(1);
    expect(mem.breakdown?.totalBytes).toBe(30 * GiB);
  });

  it("counts an unpinned model's memory as available, a pinned one's as not", () => {
    // Our two models hold 20 GB of what the listing reports as used.
    view.devices[1].freeBytes = 10 * GiB;
    __setLoadedFootprintsForTest([
      { id: "a", displayName: "A", pinned: false, status: "loaded", estBytes: 12 * GiB },
      { id: "p", displayName: "P", pinned: true, status: "loaded", estBytes: 8 * GiB },
    ]);
    const mem = availableMemory();
    expect(mem.bytes).toBe(14 * GiB + 12 * GiB);
    expect(mem.breakdown).toMatchObject({ reclaimableBytes: 12 * GiB, pinnedBytes: 8 * GiB, otherBytes: 26 * GiB });
  });

  it("counts a pinned model's own memory as available when measuring that model", () => {
    view.devices[1].freeBytes = 22 * GiB;
    __setLoadedFootprintsForTest([{ id: "p", displayName: "P", pinned: true, status: "loaded", estBytes: 8 * GiB }]);
    expect(availableMemory("p").bytes).toBe(26 * GiB + 8 * GiB);
    expect(availableMemory("other").bytes).toBe(26 * GiB);
  });

  it("never reports other programs as holding negative memory when our estimates run high", () => {
    view.devices[1].freeBytes = 29 * GiB;
    // Estimated at 5 GB, but only 1 GB of the second card is in use at all.
    __setLoadedFootprintsForTest([{ id: "a", displayName: "A", pinned: false, status: "loaded", estBytes: 5 * GiB }]);
    const mem = availableMemory();
    expect(mem.breakdown?.otherBytes).toBeGreaterThanOrEqual(0);
    // Ours is capped at what is in use (27 GB), so nothing is double-counted.
    expect((mem.breakdown?.reclaimableBytes ?? 0) + (mem.breakdown?.otherBytes ?? 0)).toBe(27 * GiB);
    expect(mem.bytes).toBeLessThanOrEqual(60 * GiB + MiB);
  });

  it("has no breakdown on the CPU", () => {
    cpu = true;
    expect(availableMemory()).toEqual({ bytes: 64 * GiB, cpu: true, breakdown: null });
  });
});
