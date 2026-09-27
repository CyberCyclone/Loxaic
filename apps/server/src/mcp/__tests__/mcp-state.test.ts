import { describe, expect, it } from "vitest";
import {
  mcpDefaultFor,
  mcpExplicitChoice,
  mcpServerActive,
  normalizeMcpOverrides,
  withMcpChoice,
} from "@loxaic/types";

/** The rule both the registry and the client's switches apply, so a server's
 * state on screen is always the state the next run is given. */

const server = (d: Partial<{ onInChat: boolean; onInAgent: boolean; onInRoutines: boolean }> = {}) => ({
  id: "s1",
  onInChat: true,
  onInAgent: true,
  onInRoutines: true,
  ...d,
});

describe("mcpServerActive", () => {
  it("follows each kind's own default", () => {
    const s = server({ onInChat: false, onInAgent: true, onInRoutines: false });
    expect(mcpServerActive(s, "chat", null)).toBe(false);
    expect(mcpServerActive(s, "agent", null)).toBe(true);
    expect(mcpServerActive(s, "routine", null)).toBe(false);
    expect(mcpDefaultFor(server({ onInRoutines: false }), "routine")).toBe(false);
  });

  it("puts a conversation's own choice above the default, both ways", () => {
    expect(mcpServerActive(server(), "chat", { disabledServerIds: ["s1"] })).toBe(false);
    expect(mcpServerActive(server({ onInChat: false }), "chat", { enabledServerIds: ["s1"] })).toBe(true);
  });

  it("treats a server in both lists as off", () => {
    expect(mcpServerActive(server(), "chat", { disabledServerIds: ["s1"], enabledServerIds: ["s1"] })).toBe(false);
  });

  it("ignores choices about other servers", () => {
    const o = { disabledServerIds: ["s2"], enabledServerIds: ["s3"] };
    expect(mcpExplicitChoice("s1", o)).toBeNull();
    expect(mcpServerActive(server({ onInAgent: false }), "agent", o)).toBe(false);
  });

  it("reads a legacy row with only disabledServerIds", () => {
    expect(mcpServerActive(server(), "agent", { disabledServerIds: ["s1"] })).toBe(false);
    expect(mcpServerActive(server(), "agent", {})).toBe(true);
  });
});

describe("withMcpChoice", () => {
  it("records an explicit choice and moves it between lists", () => {
    const off = withMcpChoice(null, "s1", false);
    expect(off).toEqual({ disabledServerIds: ["s1"], enabledServerIds: [] });
    const on = withMcpChoice(off, "s1", true);
    expect(on).toEqual({ disabledServerIds: [], enabledServerIds: ["s1"] });
  });

  it("keeps other servers' choices", () => {
    const o = withMcpChoice({ disabledServerIds: ["s2"], enabledServerIds: ["s3"] }, "s1", false);
    expect(o).toEqual({ disabledServerIds: ["s2", "s1"], enabledServerIds: ["s3"] });
  });
});

describe("normalizeMcpOverrides", () => {
  it("returns null for anything that is not an object", () => {
    for (const v of [undefined, null, "x", 3, ["s1"]]) expect(normalizeMcpOverrides(v)).toBeNull();
  });

  it("keeps strings, stringifies numbers, drops the rest, and de-duplicates", () => {
    expect(normalizeMcpOverrides({ disabledServerIds: ["a", "a", 7, null, { x: 1 }], enabledServerIds: "b" })).toEqual({
      disabledServerIds: ["a", "7"],
      enabledServerIds: [],
    });
  });

  it("keeps a server named in both lists only as disabled", () => {
    expect(normalizeMcpOverrides({ disabledServerIds: ["a"], enabledServerIds: ["a", "b"] })).toEqual({
      disabledServerIds: ["a"],
      enabledServerIds: ["b"],
    });
  });
});
