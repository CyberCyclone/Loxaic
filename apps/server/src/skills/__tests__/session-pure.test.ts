import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@loxaic/types";
import { builtinCatalogSkills, summarize, type CatalogSkill } from "../catalog.ts";
import { advanceSnapshot, coerceSnapshot, invokedSkill, listingFor } from "../session.ts";

const s = (name: string, body = "b"): CatalogSkill => ({
  name, description: `${name} d`, source: "user", body, modelInvocable: true,
});

describe("advanceSnapshot", () => {
  const a = summarize(s("a"));
  const b = summarize(s("b"));

  it("freezes the list on the first run, telling nobody", () => {
    expect(advanceSnapshot(null, [a], "0")).toEqual({ snapshot: { base: [a], frontKey: "0" }, notice: null, dirty: true });
  });

  it("leaves the frozen list alone and announces a change once", () => {
    const first = advanceSnapshot({ base: [a], frontKey: "0" }, [a, b], "0");
    expect(first.snapshot).toEqual({ base: [a], latest: [a, b], frontKey: "0" });
    expect(first.notice?.summary).toBe("Skills changed: added b");
    const again = advanceSnapshot(first.snapshot, [a, b], "0");
    expect(again).toEqual({ snapshot: first.snapshot, notice: null, dirty: false });
  });

  it("takes the live list when a compaction has moved the front", () => {
    const moved = advanceSnapshot({ base: [a], latest: [a, b], frontKey: "0" }, [a, b], "123");
    expect(moved).toEqual({ snapshot: { base: [a, b], frontKey: "123" }, notice: null, dirty: true });
  });
});

describe("listingFor", () => {
  const a = summarize(s("a"));
  it("lists the frozen list, even once the live one has moved on", () => {
    expect(listingFor({ base: [a], latest: [], frontKey: "0" })).toBeNull();
    expect(listingFor({ base: [], latest: [a], frontKey: "0" })).toEqual([]);
    expect(listingFor({ base: [a], frontKey: "0" })).toEqual([{ name: "a", description: "a d" }]);
  });
});

describe("coerceSnapshot", () => {
  it("drops what is not a snapshot", () => {
    expect(coerceSnapshot(null)).toBeNull();
    expect(coerceSnapshot({ base: "x", frontKey: "0" })).toBeNull();
    expect(coerceSnapshot({ base: [{ name: 1 }], frontKey: "0" })).toEqual({ base: [], frontKey: "0" });
  });
});

describe("invokedSkill", () => {
  const live = [...builtinCatalogSkills(), s("mine")];
  const text = (t: string): ContentBlock[] => [{ kind: "text", text: t }];
  it("reads a leading /name that names a skill", () => {
    expect(invokedSkill(text("/debug the login page"), live)?.name).toBe("debug");
    expect(invokedSkill(text("/MINE"), live)?.name).toBe("mine");
  });
  it("ignores an unknown name, a slash later in the text, and an action skill", () => {
    expect(invokedSkill(text("/nope do it"), live)).toBeNull();
    expect(invokedSkill(text("please /debug"), live)).toBeNull();
    expect(invokedSkill(text("/compact keep it"), live)).toBeNull();
  });
});
