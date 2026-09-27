import { describe, expect, it } from "vitest";
import { noRoomMessage, planRoom, type RoomCandidate } from "../room.ts";

/**
 * The decision of what to unload before loading a model, and when to refuse
 * instead. Pure: every input is a measurement, so each branch is stated here
 * with numbers rather than reached through a router.
 */

const GiB = 1024 ** 3;

function model(id: string, over: Partial<RoomCandidate> = {}): RoomCandidate {
  return { id, displayName: id.toUpperCase(), pinned: false, busy: false, lastUsedAt: 0, estBytes: 10 * GiB, ...over };
}

describe("planRoom", () => {
  it("proceeds when the model already fits comfortably", () => {
    expect(planRoom({ requiredBytes: 8 * GiB, freeBytes: 20 * GiB, loaded: [model("a")], countCap: 0 })).toEqual({ kind: "proceed" });
  });

  it("unloads unpinned models, least recently used first, only until it fits", () => {
    const plan = planRoom({
      requiredBytes: 14 * GiB,
      freeBytes: 5 * GiB,
      loaded: [model("newest", { lastUsedAt: 300 }), model("oldest", { lastUsedAt: 100 }), model("middle", { lastUsedAt: 200 })],
      countCap: 0,
    });
    // 5 + 10 = 15 GiB is not comfortable for 14 (0.93 > 0.85); 25 GiB is.
    expect(plan).toEqual({ kind: "evict", ids: ["oldest", "middle"] });
  });

  it("never unloads a pinned model or one that is answering someone", () => {
    const plan = planRoom({
      requiredBytes: 14 * GiB,
      freeBytes: 5 * GiB,
      loaded: [model("pinned", { pinned: true }), model("busy", { busy: true }), model("idle", { lastUsedAt: 999 })],
      countCap: 0,
    });
    expect(plan).toEqual({ kind: "evict", ids: ["idle"] });
  });

  it("refuses, naming the pinned models, when they are what leaves no room", () => {
    const plan = planRoom({
      requiredBytes: 20 * GiB,
      freeBytes: 4 * GiB,
      loaded: [model("p1", { pinned: true }), model("idle")],
      countCap: 0,
    });
    // Unloading "idle" still leaves 14 GiB for 20: won't fit, and a pinned
    // model is loaded.
    expect(plan).toEqual({ kind: "refuse", blockers: [{ id: "p1", displayName: "P1" }] });
  });

  it("proceeds on a might-fit rather than refusing: llama.cpp's --fit may still load it", () => {
    const plan = planRoom({
      requiredBytes: 11 * GiB,
      freeBytes: 10.5 * GiB,
      loaded: [model("p1", { pinned: true })],
      countCap: 0,
    });
    expect(plan).toEqual({ kind: "proceed" });
  });

  it("does not refuse a model too big for an empty GPU when nothing is pinned", () => {
    const plan = planRoom({ requiredBytes: 90 * GiB, freeBytes: 4 * GiB, loaded: [model("a")], countCap: 0 });
    // Everything unpinned goes, and the admin's own download decision stands.
    expect(plan).toEqual({ kind: "evict", ids: ["a"] });
  });

  it("does not refuse because of a busy unpinned model", () => {
    const plan = planRoom({ requiredBytes: 20 * GiB, freeBytes: 4 * GiB, loaded: [model("busy", { busy: true })], countCap: 0 });
    expect(plan).toEqual({ kind: "proceed" });
  });

  it("applies the count cap even when memory is plentiful or unknown", () => {
    const loaded = [model("a", { lastUsedAt: 1 }), model("b", { lastUsedAt: 2 })];
    expect(planRoom({ requiredBytes: GiB, freeBytes: 100 * GiB, loaded, countCap: 2 })).toEqual({ kind: "evict", ids: ["a"] });
    expect(planRoom({ requiredBytes: GiB, freeBytes: null, loaded, countCap: 2 })).toEqual({ kind: "evict", ids: ["a"] });
    expect(planRoom({ requiredBytes: GiB, freeBytes: null, loaded, countCap: 0 })).toEqual({ kind: "proceed" });
  });

  it("refuses at the count cap when every loaded model is pinned", () => {
    const plan = planRoom({ requiredBytes: GiB, freeBytes: 100 * GiB, loaded: [model("p", { pinned: true })], countCap: 1 });
    expect(plan).toEqual({ kind: "refuse", blockers: [{ id: "p", displayName: "P" }] });
  });
});

describe("noRoomMessage", () => {
  it("names the model and every pinned one, and says who can fix it", () => {
    expect(noRoomMessage("Qwen 27B", ["Gemma"])).toBe(
      "\"Qwen 27B\" can't be loaded right now: there isn't enough GPU memory on this host while \"Gemma\" is pinned. " +
        "Pick a model that is already loaded, or ask an admin to unpin it under Settings > Host models.",
    );
    expect(noRoomMessage("Qwen", ["A", "B", "C"])).toContain("while \"A\", \"B\" and \"C\" are pinned");
    expect(noRoomMessage("Qwen", ["A", "B"])).toContain("unpin one of them");
  });
});
