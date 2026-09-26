import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { forwardPowerEvents } from "../power.js";

describe("forwardPowerEvents", () => {
  it("says sleep for a suspend or a lock, and wake for a resume or an unlock", () => {
    const monitor = new EventEmitter();
    const sent = [];
    forwardPowerEvents(monitor, (state) => sent.push(state));
    for (const event of ["suspend", "resume", "lock-screen", "unlock-screen", "shutdown"]) monitor.emit(event);
    expect(sent).toEqual(["sleep", "wake", "sleep", "wake"]);
  });

  it("stops when unsubscribed", () => {
    const monitor = new EventEmitter();
    const sent = [];
    forwardPowerEvents(monitor, (state) => sent.push(state))();
    monitor.emit("resume");
    expect(sent).toEqual([]);
    expect(monitor.eventNames()).toEqual([]);
  });
});
