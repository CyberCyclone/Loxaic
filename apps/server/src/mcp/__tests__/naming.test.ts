import { describe, expect, it } from "vitest";
import { isValidSlug, namespaceTool, splitNamespaced, SLUG_RE } from "../naming.ts";

describe("mcp naming", () => {
  it("accepts normal slugs", () => {
    expect(isValidSlug("brave")).toBe(true);
    expect(isValidSlug("my-server-2")).toBe(true);
  });

  it("rejects bad charsets, lengths, and builtin collisions", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("Has-Caps")).toBe(false);
    expect(isValidSlug("under_score")).toBe(false);
    expect(isValidSlug("a".repeat(40))).toBe(false);
    // Builtin tool names may not be slugs, even though the `__` separator
    // already prevents collisions.
    expect(isValidSlug("bash")).toBe(false);
    expect(isValidSlug("web_fetch")).toBe(false); // also fails SLUG_RE
  });

  it("namespaces tools and coerces hostile remote names", () => {
    expect(namespaceTool("brave", "web_search")).toBe("brave__web_search");
    expect(namespaceTool("s", "we ird/na.me")).toBe("s__we_ird_na_me");
    expect(namespaceTool("s", "x".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("splits namespaced names and leaves builtins alone", () => {
    expect(splitNamespaced("brave__web_search")).toEqual({ slug: "brave", remoteName: "web_search" });
    expect(splitNamespaced("brave__a__b")).toEqual({ slug: "brave", remoteName: "a__b" });
    expect(splitNamespaced("bash")).toBeNull();
    expect(splitNamespaced("__x")).toBeNull();
  });

  it("no builtin tool name matches the namespaced shape", () => {
    // The guarantee the whole scheme rests on: builtins never contain `__`.
    for (const name of ["fs_read", "fs_write", "fs_edit", "bash", "grep", "glob", "web_fetch", "todo_write"]) {
      expect(splitNamespaced(name)).toBeNull();
      expect(SLUG_RE.test(name) && name.includes("__")).toBe(false);
    }
  });
});
