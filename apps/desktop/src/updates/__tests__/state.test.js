import { describe, it, expect } from "vitest";
import { initialState, reduce } from "../state.js";

const run = (state, ...events) => events.reduce(reduce, state);

describe("updater state", () => {
  it("starts idle, and off when the updater is disabled", () => {
    expect(initialState({ version: "1.2.3" })).toMatchObject({ status: "idle", enabled: true, error: null });
    expect(initialState({ enabled: false, disabledReason: "development build" })).toMatchObject({
      status: "off",
      disabledReason: "development build",
    });
  });

  it("walks a download through to ready", () => {
    const state = run(
      initialState({ version: "1.2.3" }),
      { type: "checking" },
      { type: "available", version: "1.2.4" },
      { type: "progress", percent: 42 },
      { type: "downloaded", version: "1.2.4" },
    );
    expect(state).toMatchObject({ status: "ready", availableVersion: "1.2.4", progress: 1 });
  });

  it("clears a previous error when a new check starts", () => {
    // Checks fail for ordinary passing reasons — a laptop that just woke with
    // no network yet. An error that never clears turns that into a permanent
    // accusation in Settings.
    const state = run(
      initialState({}),
      { type: "error", message: "net::ERR_INTERNET_DISCONNECTED" },
      { type: "checking" },
    );
    expect(state).toMatchObject({ status: "checking", error: null });
  });

  it("keeps a downloaded update through every later check", () => {
    // The six-hourly timer keeps running after a download. Without this, its
    // events would walk "an update is ready" off the screen for an update
    // that is still on disk and still installs on the next restart.
    const ready = run(initialState({}), { type: "downloaded", version: "2.0.0" });
    for (const event of [
      { type: "checking" },
      { type: "not-available" },
      { type: "available", version: "2.0.0" },
      { type: "progress", percent: 3 },
      { type: "error", message: "rate limited" },
    ]) {
      expect(reduce(ready, event)).toMatchObject({ status: "ready", availableVersion: "2.0.0" });
    }
  });

  it("reports an error that happens while installing, sticky rule or not", () => {
    // quitAndInstall reports failure by emitting `error` — at status `ready`,
    // which the sticky rule absorbed. The person pressed Restart, nothing
    // happened, and the row went on saying an update was ready, forever.
    const ready = run(initialState({}), { type: "downloaded", version: "2.0.0" });
    const failed = run(ready, { type: "installing" }, { type: "error", message: "installer exited 1" });
    expect(failed).toMatchObject({ status: "error", error: "installer exited 1", installing: false });
    // A later check's error, with no install in flight, still leaves the offer.
    expect(reduce(ready, { type: "error", message: "rate limited" })).toMatchObject({ status: "ready" });
    // And a new check clears the installing window.
    expect(run(ready, { type: "installing" }, { type: "checking" }).installing).toBe(false);
  });

  it("carries the variant it was packaged as", () => {
    // Which releases this install follows is not a preference the reducer can
    // change: "Loxaic Beta" is a separate application. The state carries it so
    // the settings row can say so, and nothing else.
    expect(initialState({ variant: "beta" })).toMatchObject({ variant: "beta" });
    expect(initialState({})).toMatchObject({ variant: "production" });
  });

  it("ignores every event while the updater is off", () => {
    // There is nothing left to record: with the channel fixed at package
    // time, a disabled updater has no state anything could change.
    const off = initialState({ enabled: false, disabledReason: "development build" });
    expect(reduce(off, { type: "available", version: "1.0.0" })).toBe(off);
    expect(reduce(off, { type: "checking" })).toBe(off);
  });

  it("reports progress as a fraction, and refuses nonsense", () => {
    expect(reduce(initialState({}), { type: "progress", percent: 150 }).progress).toBe(1);
    expect(reduce(initialState({}), { type: "progress", percent: undefined }).progress).toBe(null);
  });
});
