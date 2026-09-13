import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * The packaging config decides what a beta tester actually installs. Two of
 * its fields are load-bearing in ways that only show up after a release is
 * published, which is far too late to find out:
 *
 *   - `publish.channel: "beta"` is what makes the beta variant write
 *     `beta*.yml`. Without it both variants would write `latest*.yml` and the
 *     second one uploaded into a release would overwrite the first.
 *   - `extraMetadata.productName` is what Electron reads for `app.name`, and
 *     therefore `userData` — the thing that keeps the two apps' embedded
 *     Postgres data directories apart.
 */
const require_ = createRequire(import.meta.url);
const { configFor } = require_("../builder-variants.cjs");

describe("the electron-builder config", () => {
  it("packages the stable app by default", () => {
    const config = configFor(undefined);
    expect(config.productName).toBe("Loxaic");
    expect(config.appId).toBe("com.loxaic.desktop");
    // No channel: electron-builder writes latest*.yml, which is what an
    // installed stable app asks /releases/latest for.
    expect(config.publish[0].channel).toBeUndefined();
    expect(config.extraMetadata).toEqual({ productName: "Loxaic", loxaicVariant: "production" });
  });

  it("packages the beta app as a separate application", () => {
    const config = configFor("beta");
    expect(config.productName).toBe("Loxaic Beta");
    // A different appId is what lets both be installed at once; the same id
    // would make one an upgrade of the other.
    expect(config.appId).toBe("com.loxaic.desktop.beta");
    expect(config.publish[0].channel).toBe("beta");
    expect(config.extraMetadata).toEqual({ productName: "Loxaic Beta", loxaicVariant: "beta" });
  });

  it("names the beta artifacts without a space", () => {
    // ${productName} would interpolate to "Loxaic Beta", and an installer
    // called "Loxaic Beta-1.2.3-mac-arm64.dmg" is a link nobody can paste.
    expect(configFor("beta").artifactName).toBe("Loxaic-Beta-${version}-${os}-${arch}.${ext}");
    expect(configFor("production").artifactName).toBe("Loxaic-${version}-${os}-${arch}.${ext}");
  });

  it("pins the Linux executable name rather than letting it be inferred", () => {
    // electron-builder lowercases the product name without replacing
    // whitespace, so "Loxaic Beta" would produce `loxaic beta` — a name with
    // a space in a .desktop entry, and one nothing outside the build could
    // guess. Naming it makes it ours.
    expect(configFor("beta").linux.executableName).toBe("loxaic-beta");
    expect(configFor("production").linux.executableName).toBe("loxaic");
  });

  it("refuses a variant it does not know", () => {
    expect(() => configFor("nightly")).toThrow(/LOXAIC_VARIANT="nightly"/);
  });

  it("keeps the packaging facts both variants depend on", () => {
    for (const variant of ["production", "beta"]) {
      const config = configFor(variant);
      // zip alongside dmg: MacUpdater downloads the zip, and without it a mac
      // update has nothing to fetch. asar false so embedded-postgres can
      // spawn its own binaries and the app can read its package.json.
      expect(config.mac.target).toEqual(["dmg", "zip"]);
      expect(config.asar).toBe(false);
      expect(config.npmRebuild).toBe(false);
      expect(config.mac.notarize).toBe(true);
      expect(config.mac.hardenedRuntime).toBe(true);
      expect(config.publish[0]).toMatchObject({ provider: "github", owner: "CyberCyclone", repo: "Open-Shannon" });
    }
  });

  it("carries the metadata a .deb refuses to build without", () => {
    // FpmTarget.computeFpmMetaInfoOptions throws unless there is a homepage
    // and a maintainer — and it throws only when the deb target actually
    // builds, which happens on a Linux release runner and nowhere else. The
    // first release uploaded its AppImage and then died on exactly this, so it
    // is asserted here, where a missing field costs seconds instead of a tag.
    const pkg = require_("../../package.json");
    expect(pkg.homepage).toMatch(/^https:\/\//);
    for (const variant of ["production", "beta"]) {
      expect(configFor(variant).linux.maintainer).toMatch(/^.+ <[^>]+@[^>]+>$/);
    }
  });
});
