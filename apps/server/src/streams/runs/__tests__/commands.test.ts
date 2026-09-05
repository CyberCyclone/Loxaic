import { describe, expect, it } from "vitest";
import { commandQuery, parseCommand } from "@loxaic/types";

describe("commandQuery", () => {
  it("shows everything on a bare slash", () => {
    expect(commandQuery("/")).toBe("");
  });

  it("returns the lowercased prefix while a name is being typed", () => {
    expect(commandQuery("/comp")).toBe("comp");
    expect(commandQuery("/COMPACT")).toBe("compact");
  });

  it("closes the instant a space is typed, even with nothing after it", () => {
    expect(commandQuery("/compact ")).toBeNull();
    expect(commandQuery("/compact focus on X")).toBeNull();
  });

  it("is null for anything not shaped like a command", () => {
    expect(commandQuery("")).toBeNull();
    expect(commandQuery("not/a/command")).toBeNull();
    expect(commandQuery("hello")).toBeNull();
    expect(commandQuery(" /compact")).toBeNull(); // leading whitespace breaks the anchor
  });
});

describe("parseCommand", () => {
  it("parses a bare command with no args", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
  });

  it("parses args, trimmed", () => {
    expect(parseCommand("/compact focus on X")).toEqual({ name: "compact", args: "focus on X" });
    expect(parseCommand("/compact   trailing space   ")).toEqual({ name: "compact", args: "trailing space" });
  });

  it("lowercases the command name but preserves arg casing", () => {
    expect(parseCommand("/COMPACT Focus On X")).toEqual({ name: "compact", args: "Focus On X" });
  });

  it("tolerates leading/trailing whitespace around the whole input", () => {
    expect(parseCommand("  /compact  ")).toEqual({ name: "compact", args: "" });
  });

  it("returns null for anything not shaped like an invocation", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("not/a/command")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("still parses an unknown command name — the registry lookup is the caller's job", () => {
    // parseCommand only recognizes shape; findCommand is what decides real vs.
    // not, which is what lets "/foo bar" fall through to plain text.
    expect(parseCommand("/unknown-thing here")).toEqual({ name: "unknown-thing", args: "here" });
  });
});
