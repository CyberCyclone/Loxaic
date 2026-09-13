import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appVariant } from "../variant.js";

/**
 * Which app a running process is — read from the packaged package.json, the
 * only thing available at run time (LOXAIC_VARIANT exists at package time).
 * Getting this wrong picks the wrong data directory, which is how a beta
 * would end up sharing an embedded Postgres with the stable install.
 */
let dir;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-variant-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function pkg(contents) {
  const file = path.join(dir, "package.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

describe("appVariant", () => {
  it("reads the beta variant that electron-builder stamped in", () => {
    expect(appVariant(pkg({ productName: "Loxaic Beta", loxaicVariant: "beta" }))).toEqual({
      name: "beta",
      productName: "Loxaic Beta",
      prerelease: true,
    });
  });

  it("reads the stable variant", () => {
    expect(appVariant(pkg({ productName: "Loxaic", loxaicVariant: "production" }))).toEqual({
      name: "production",
      productName: "Loxaic",
      prerelease: false,
    });
  });

  it("is the ordinary app when the fields are absent", () => {
    // A repo checkout: `pnpm dev` has no extraMetadata, and a developer's
    // data directory must not move because of that.
    expect(appVariant(pkg({ name: "@loxaic/desktop" }))).toEqual({
      name: "production",
      productName: "Loxaic",
      prerelease: false,
    });
  });

  it("is the ordinary app rather than a failure when the file cannot be read", () => {
    // Refusing to start over an unreadable package.json would be the wrong
    // trade: being the stable app is the safe answer, and it is also right.
    expect(appVariant(path.join(dir, "nothing-here.json")).name).toBe("production");
    expect(appVariant(pkg("{ not json")).name).toBe("production");
  });

  it("treats an unrecognised variant as production rather than trusting it", () => {
    // Unlike app.config.js, which throws: there the value comes from a build
    // profile and a typo must fail loudly, while here it comes from a file on
    // a user's disk and the app still has to start.
    expect(appVariant(pkg({ productName: "Loxaic", loxaicVariant: "nightly" })).name).toBe("production");
  });
});
