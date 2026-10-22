import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { user, userSandboxAllocations } from "@loxaic/db/schema";
import {
  AllocationInputError,
  allocationDecision,
  allocationFor,
  allocationMessage,
  clearAllocationOverride,
  resolveAllocation,
  rowNeed,
  setAllocationOverride,
  usageOf,
} from "../allocation.ts";

/**
 * The allocation's decisions (#254), pure, and the per-user override's
 * storage. What the sandbox manager does with a refusal is
 * allocation-enforce.test.ts.
 */
const allocation = { memoryMb: 2560, cpus: 5, maxRunning: 5 };
const none = { running: 0, memoryMb: 0, cpus: 0 };

describe("allocationDecision", () => {
  it("lets a sandbox in while everything fits", () => {
    expect(allocationDecision(none, { memoryMb: 512, cpus: 1 }, allocation)).toEqual({ ok: true });
  });

  it("fits exactly at the allocation, not over it", () => {
    const used = { running: 4, memoryMb: 2048, cpus: 4 };
    expect(allocationDecision(used, { memoryMb: 512, cpus: 1 }, allocation)).toEqual({ ok: true });
    expect(allocationDecision(used, { memoryMb: 513, cpus: 1 }, allocation)).toEqual({ ok: false, reason: "memory" });
  });

  it("refuses the sixth sandbox on a count of five, however small", () => {
    const used = { running: 5, memoryMb: 0, cpus: 0 };
    expect(allocationDecision(used, { memoryMb: 0, cpus: 0 }, allocation)).toEqual({ ok: false, reason: "count" });
  });

  it("refuses on CPUs when memory would fit", () => {
    const used = { running: 1, memoryMb: 512, cpus: 4.5 };
    expect(allocationDecision(used, { memoryMb: 512, cpus: 1 }, allocation)).toEqual({ ok: false, reason: "cpus" });
  });

  it("says too big, not full, for a sandbox larger than the whole allocation", () => {
    // Even with nothing running: pausing cannot make room that does not exist.
    expect(allocationDecision(none, { memoryMb: 16_384, cpus: 1 }, allocation)).toEqual({ ok: false, reason: "too_big" });
    expect(allocationDecision(none, { memoryMb: 512, cpus: 8 }, allocation)).toEqual({ ok: false, reason: "too_big" });
    const full = { running: 5, memoryMb: 2560, cpus: 5 };
    expect(allocationDecision(full, { memoryMb: 16_384, cpus: 1 }, allocation)).toEqual({ ok: false, reason: "too_big" });
  });

  it("adds fractional CPUs without float drift", () => {
    const tight = { memoryMb: 2560, cpus: 0.3, maxRunning: 5 };
    expect(allocationDecision({ running: 1, memoryMb: 0, cpus: 0.1 }, { memoryMb: 0, cpus: 0.2 }, tight)).toEqual({ ok: true });
  });
});

describe("allocationMessage", () => {
  it("names the numbers and what to do for each reason", () => {
    const need = { memoryMb: 512, cpus: 1 };
    expect(allocationMessage("count", { running: 5, memoryMb: 2560, cpus: 5 }, need, allocation)).toBe(
      "You have 5 sandboxes running or starting, and your allocation allows 5. " +
        "Pause one in Settings → Sandboxes, or ask an admin to raise your allocation.",
    );
    expect(allocationMessage("memory", { running: 2, memoryMb: 2304, cpus: 2 }, need, allocation)).toBe(
      "Your running sandboxes use 2.3 GB of the 2.5 GB of memory in your allocation, and this one needs 512 MB. " +
        "Pause one in Settings → Sandboxes, or ask an admin to raise your allocation.",
    );
    expect(allocationMessage("cpus", { running: 1, memoryMb: 512, cpus: 4.5 }, need, allocation)).toBe(
      "Your running sandboxes use 4.5 CPUs of the 5 CPUs in your allocation, and this one needs 1 CPU. " +
        "Pause one in Settings → Sandboxes, or ask an admin to raise your allocation.",
    );
    expect(allocationMessage("too_big", none, { memoryMb: 16_384, cpus: 8 }, allocation)).toBe(
      "This sandbox needs 16 GB and 8 CPUs, more than your whole sandbox allocation (2.5 GB, 5 CPUs). " +
        "Ask an admin to raise your allocation.",
    );
  });

  it("states the allocation's own number once an admin has lowered it below what runs", () => {
    expect(allocationMessage("count", { running: 7, memoryMb: 0, cpus: 0 }, { memoryMb: 0, cpus: 0 }, { ...allocation, maxRunning: 3 })).toBe(
      "You have 7 sandboxes running or starting, and your allocation allows 3. " +
        "Pause one in Settings → Sandboxes, or ask an admin to raise your allocation.",
    );
  });
});

describe("usageOf", () => {
  it("sums what each row holds, and counts a host row as one running with nothing held", () => {
    expect(
      usageOf([
        { provider: "container", limits: { memory: 16_384, cpu: 8 } },
        { provider: "container", limits: null },
        { provider: "host", limits: null },
      ]),
    ).toEqual({ running: 3, memoryMb: 16_896, cpus: 9 });
  });
});

describe("rowNeed", () => {
  it("reads a container's recorded limits", () => {
    expect(rowNeed({ provider: "container", limits: { memory: 16_384, cpu: 8, network: true } })).toEqual({ memoryMb: 16_384, cpus: 8 });
  });

  it("falls back to the default container for a row with no limits recorded", () => {
    expect(rowNeed({ provider: "container", limits: null })).toEqual({ memoryMb: 512, cpus: 1 });
  });

  it("counts nothing for a host sandbox, whose resources nothing enforces", () => {
    expect(rowNeed({ provider: "host", limits: { memory: 512, cpu: 1 } })).toEqual({ memoryMb: 0, cpus: 0 });
  });
});

describe("resolveAllocation", () => {
  it("is the default with no override", () => {
    expect(resolveAllocation(undefined, allocation, false)).toEqual({
      allocation,
      overridden: { memoryMb: false, cpus: false, maxRunning: false },
    });
  });

  it("takes each part an admin set and the default for the rest", () => {
    expect(resolveAllocation({ memoryMb: 16_384, cpus: null, maxRunning: 2 }, allocation, false)).toEqual({
      allocation: { memoryMb: 16_384, cpus: 5, maxRunning: 2 },
      overridden: { memoryMb: true, cpus: false, maxRunning: true },
    });
  });

  it("lets SANDBOX_MAX_PER_USER's pin win over a per-user count", () => {
    expect(resolveAllocation({ memoryMb: null, cpus: null, maxRunning: 9 }, { ...allocation, maxRunning: 3 }, true)).toEqual({
      allocation: { ...allocation, maxRunning: 3 },
      overridden: { memoryMb: false, cpus: false, maxRunning: false },
    });
  });
});

describe("a user's override", () => {
  const userId = `test-allocation-${uuid()}`;

  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Allocation",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    Reflect.deleteProperty(process.env, "SANDBOX_MAX_PER_USER");
    await clearAllocationOverride(userId);
  });

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, userId));
  });

  async function storedRow() {
    return db.query.userSandboxAllocations.findFirst({ where: eq(userSandboxAllocations.userId, userId) });
  }

  it("sets one part and leaves the others on the default", async () => {
    const resolved = await setAllocationOverride(userId, { memoryMb: 16_384 });
    expect(resolved.overridden).toEqual({ memoryMb: true, cpus: false, maxRunning: false });
    expect(resolved.allocation.memoryMb).toBe(16_384);
    expect((await allocationFor(userId)).allocation.memoryMb).toBe(16_384);
  });

  it("merges a later change into what is there", async () => {
    await setAllocationOverride(userId, { memoryMb: 16_384 });
    await setAllocationOverride(userId, { cpus: 8 });
    const row = await storedRow();
    expect(row?.memoryMb).toBe(16_384);
    expect(row?.cpus).toBe(8);
  });

  it("puts a part back on the default with null, and drops the row once nothing is left", async () => {
    await setAllocationOverride(userId, { memoryMb: 16_384, cpus: 8 });
    await setAllocationOverride(userId, { memoryMb: null });
    expect((await storedRow())?.memoryMb).toBeNull();
    await setAllocationOverride(userId, { cpus: null });
    expect(await storedRow()).toBeUndefined();
  });

  it("refuses what the default would refuse", async () => {
    await expect(setAllocationOverride(userId, { memoryMb: 100 })).rejects.toThrow("memoryMb must be between 256 and 1048576");
    await expect(setAllocationOverride(userId, { maxRunning: 1.5 })).rejects.toThrow("maxRunning must be a whole number");
    await expect(setAllocationOverride(userId, { cpus: "4" })).rejects.toThrow("cpus must be a number");
    await expect(setAllocationOverride(userId, { disk: 10 })).rejects.toThrow('allocation has no field "disk"');
    await expect(setAllocationOverride(userId, [])).rejects.toBeInstanceOf(AllocationInputError);
    expect(await storedRow()).toBeUndefined();
  });

  it("refuses a count while SANDBOX_MAX_PER_USER pins it, as a conflict", async () => {
    process.env.SANDBOX_MAX_PER_USER = "3";
    const refusal = await setAllocationOverride(userId, { maxRunning: 2 }).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(AllocationInputError);
    expect((refusal as AllocationInputError).status).toBe(409);
  });
});
