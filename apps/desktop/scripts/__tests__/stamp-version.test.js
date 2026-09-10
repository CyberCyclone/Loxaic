import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseReleaseTag, stampFiles } from "../stamp-version.mjs";

describe("parseReleaseTag", () => {
  it("parses a release tag as the production channel", () => {
    expect(parseReleaseTag("v1.2.3")).toEqual({
      version: "1.2.3",
      prerelease: false,
      channel: "production",
    });
  });

  it("parses a beta tag as the beta channel", () => {
    expect(parseReleaseTag("v1.2.3-beta.4")).toEqual({
      version: "1.2.3-beta.4",
      prerelease: true,
      channel: "beta",
    });
  });

  it("rejects anything that isn't exactly vX.Y.Z or vX.Y.Z-beta.N", () => {
    for (const bad of ["1.2.3", "v1.2", "v1.2.3-alpha.1", "v1.2.3-beta", "v1.2.3.4", "release"]) {
      expect(() => parseReleaseTag(bad)).toThrow(/not a release tag/);
    }
  });
});

describe("stampFiles", () => {
  function scratchRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), "loxaic-stamp-test-"));
    mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
    mkdirSync(path.join(root, "apps/server"), { recursive: true });
    mkdirSync(path.join(root, "apps/mobile"), { recursive: true });
    // Representative slices of the real files — enough to prove the
    // replace/parse logic, not full copies that would drift from the
    // originals and go stale.
    writeFileSync(
      path.join(root, "apps/desktop/package.json"),
      '{\n  "name": "@loxaic/desktop",\n  "version": "0.0.0",\n  "private": true\n}\n',
    );
    writeFileSync(
      path.join(root, "apps/server/package.json"),
      '{\n  "name": "@loxaic/server",\n  "version": "0.0.0",\n  "private": true\n}\n',
    );
    writeFileSync(
      path.join(root, "apps/mobile/app.json"),
      JSON.stringify({ expo: { name: "loxaic", slug: "loxaic", version: "0.0.0" } }, null, 2) + "\n",
    );
    return root;
  }

  it("stamps all three files with the given version", () => {
    const root = scratchRepo();
    stampFiles(root, "1.2.3-beta.4");

    const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
    const server = JSON.parse(readFileSync(path.join(root, "apps/server/package.json"), "utf8"));
    const mobile = JSON.parse(readFileSync(path.join(root, "apps/mobile/app.json"), "utf8"));

    expect(desktop.version).toBe("1.2.3-beta.4");
    expect(server.version).toBe("1.2.3-beta.4");
    expect(mobile.expo.version).toBe("1.2.3-beta.4");
  });

  it("touches exactly the version field — a package.json's other fields survive untouched", () => {
    const root = scratchRepo();
    stampFiles(root, "9.9.9");

    const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
    expect(desktop.name).toBe("@loxaic/desktop");
    expect(desktop.private).toBe(true);
  });

  it("preserves a package.json's hand-formatting rather than reserialising it", () => {
    // The regex-replace approach exists specifically so this diff is one
    // line — a JSON.stringify round trip would also normalise indentation
    // and key order, which nobody asked for.
    const root = scratchRepo();
    const before = readFileSync(path.join(root, "apps/desktop/package.json"), "utf8");
    stampFiles(root, "1.0.0");
    const after = readFileSync(path.join(root, "apps/desktop/package.json"), "utf8");

    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = beforeLines.filter((line, i) => line !== afterLines[i]);
    expect(changed).toEqual(['  "version": "0.0.0",']);
  });

  it("restamping to the version already present is a real no-op, not a missing-field error", () => {
    // A regex-replace that detects "did anything change" instead of "did the
    // field exist" mistakes this for a missing field, because the replacement
    // text happens to equal what was already there. Caught by running this
    // script against files already stamped to the version being applied.
    const root = scratchRepo();
    stampFiles(root, "0.0.0"); // scratchRepo() already starts at 0.0.0
    const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
    expect(desktop.version).toBe("0.0.0");
  });

  it("throws rather than silently no-op when a version field is missing", () => {
    const root = scratchRepo();
    writeFileSync(path.join(root, "apps/desktop/package.json"), '{\n  "name": "@loxaic/desktop"\n}\n');
    expect(() => stampFiles(root, "1.0.0")).toThrow(/no "version" field found/);
  });

  it("throws when app.json has no expo.version to stamp", () => {
    const root = scratchRepo();
    writeFileSync(path.join(root, "apps/mobile/app.json"), JSON.stringify({ expo: {} }));
    expect(() => stampFiles(root, "1.0.0")).toThrow(/no expo\.version field found/);
  });
});
