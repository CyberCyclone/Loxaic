import { describe, expect, it } from "vitest";
import { hasGit, isUsable, manageRefusal, scopeAllowed, useRefusal } from "../access.ts";
import type { CustomImagesPolicy } from "../../settings.ts";

const good = { missing: [], warnings: [] };
const noGit = { missing: [], warnings: [{ code: "git", message: "No git" }] };
const digest = `docker.io/library/x@sha256:${"b".repeat(64)}`;
const shared = { ownerId: null, digest, check: good };
const alices = { ownerId: "alice", digest, check: good };
const POLICIES: CustomImagesPolicy[] = ["off", "shared", "everyone"];

describe("scopeAllowed", () => {
  it("allows nothing when off, shared images when shared, and both when everyone", () => {
    expect(POLICIES.map((p) => [scopeAllowed(p, "shared"), scopeAllowed(p, "personal")])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });
});

describe("useRefusal", () => {
  it("lets any conversation owner use a shared image while the policy allows it", () => {
    expect(useRefusal(shared, "shared", "bob", { github: false })).toBeNull();
    expect(useRefusal(shared, "everyone", "bob", { github: false })).toBeNull();
    expect(useRefusal(shared, "off", "bob", { github: false })).toMatch(/turned off/);
  });

  it("lets only its owner use a personal image, and only when everyone may", () => {
    expect(useRefusal(alices, "everyone", "alice", { github: false })).toBeNull();
    // Someone else's reads exactly like one that does not exist.
    expect(useRefusal(alices, "everyone", "bob", { github: false })).toBe(useRefusal(null, "everyone", "bob", { github: false }));
    expect(useRefusal(alices, "shared", "alice", { github: false })).toMatch(/only shared/);
  });

  it("refuses an image with no good pull, or one whose check found something missing", () => {
    expect(useRefusal({ ...shared, digest: null }, "shared", "bob", { github: false })).toMatch(/not been pulled/);
    expect(useRefusal({ ...shared, check: { missing: ["setsid"], warnings: [] } }, "shared", "bob", { github: false }))
      .toMatch(/not been pulled/);
    expect(useRefusal({ ...shared, check: null }, "shared", "bob", { github: false })).toMatch(/not been pulled/);
  });

  it("refuses an image without git for a GitHub workspace only", () => {
    const row = { ...shared, check: noGit };
    expect(useRefusal(row, "shared", "bob", { github: false })).toBeNull();
    expect(useRefusal(row, "shared", "bob", { github: true })).toMatch(/no git/);
  });
});

describe("manageRefusal", () => {
  it("keeps shared images to admins, and needs the policy on", () => {
    expect(manageRefusal("shared", "shared", false)).toMatch(/Only an admin/);
    expect(manageRefusal("shared", "shared", true)).toBeNull();
    expect(manageRefusal("off", "shared", true)).toMatch(/turned off/);
  });

  it("lets anyone, admins included, manage their own images only when everyone may", () => {
    for (const admin of [false, true]) {
      expect(manageRefusal("everyone", "personal", admin)).toBeNull();
      expect(manageRefusal("shared", "personal", admin)).toMatch(/turned off/);
      expect(manageRefusal("off", "personal", admin)).toMatch(/turned off/);
    }
  });
});

describe("isUsable and hasGit", () => {
  it("read a stored check defensively", () => {
    expect(isUsable({ ownerId: null, digest, check: "junk" })).toBe(false);
    expect(isUsable(shared)).toBe(true);
    expect(hasGit(shared)).toBe(true);
    expect(hasGit({ ...shared, check: noGit })).toBe(false);
  });
});
