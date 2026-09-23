import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseLicense,
  collectNative,
  collectNpm,
  identifyLicence,
  licenceTextIn,
  refusedLicence,
  renderGroup,
} from "../third-party-notices.mjs";

/**
 * The notices file is a legal condition of shipping the app, and nothing at
 * runtime would ever notice it was wrong — so what it may silently get wrong
 * is pinned here: a dependency dropped because it ships no licence file, a
 * dual licence reported as the copyleft half, and a native library nobody
 * accounted for.
 */
const licensesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../licenses");
const manifest = JSON.parse(readFileSync(path.join(licensesDir, "native-libraries.json"), "utf8"));

let root;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "loxaic-notices-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel, content) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

describe("chooseLicense", () => {
  it("takes the permissive half of a dual licence and says so", () => {
    expect(chooseLicense("(MIT OR GPL-3.0-or-later)")).toBe("MIT (chosen from MIT OR GPL-3.0-or-later)");
    expect(chooseLicense("BSD-3-Clause OR GPL-2.0")).toBe("BSD-3-Clause (chosen from BSD-3-Clause OR GPL-2.0)");
  });

  it("reports a single licence or a conjunction exactly as declared", () => {
    expect(chooseLicense("Apache-2.0")).toBe("Apache-2.0");
    expect(chooseLicense("MIT AND OFL-1.1")).toBe("MIT AND OFL-1.1");
    expect(chooseLicense(undefined)).toBe("UNKNOWN");
  });
});

describe("refusedLicence", () => {
  it("refuses a copyleft or non-commercial licence in use, in any term", () => {
    expect(refusedLicence("GPL-3.0-or-later")).toBe(true);
    expect(refusedLicence("AGPL-3.0")).toBe(true);
    expect(refusedLicence("MIT AND GPL-2.0")).toBe(true);
    expect(refusedLicence("GPL-2.0 OR LGPL-2.1")).toBe(true);
    expect(refusedLicence("UNLICENSED")).toBe(true);
    expect(refusedLicence("CC-BY-NC-4.0")).toBe(true);
  });

  it("accepts the permissive half a dual licence resolved to, and the LGPL", () => {
    expect(refusedLicence("BSD-3-Clause (chosen from BSD-3-Clause OR GPL-2.0)")).toBe(false);
    expect(refusedLicence("MIT")).toBe(false);
    expect(refusedLicence("LGPL-2.1-or-later")).toBe(false);
    expect(refusedLicence("CC-BY-4.0")).toBe(false);
  });
});

describe("identifyLicence", () => {
  it("names the licence shapes Go modules actually use", () => {
    expect(identifyLicence("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0");
    expect(identifyLicence("Permission is hereby granted, free of charge, to any person")).toBe("MIT");
    expect(identifyLicence("Redistribution and use in source and binary forms ... Neither the name of Google")).toBe("BSD-3-Clause");
    expect(identifyLicence("Redistribution and use in source and binary forms, with or without")).toBe("BSD-2-Clause");
    expect(identifyLicence("Some bespoke terms")).toBe("see licence text");
    expect(identifyLicence("")).toBe("UNKNOWN");
  });
});

describe("collectNpm", () => {
  it("walks production dependencies the way Node resolves them", () => {
    write("app/package.json", { name: "app", dependencies: { a: "1", "@loxaic/own": "1" }, optionalDependencies: { "pg-other-platform": "1" }, devDependencies: { dev: "1" } });
    write("app/node_modules/a/package.json", { name: "a", version: "1.0.0", license: "MIT", dependencies: { b: "2" } });
    write("app/node_modules/a/LICENSE", "MIT text for a");
    // Hoisted one level up, as pnpm's virtual store and npm's flattening both do.
    write("node_modules/b/package.json", { name: "b", version: "2.0.0", license: "(MIT OR GPL-3.0)" });
    write("app/node_modules/dev/package.json", { name: "dev", version: "9.0.0", license: "MIT" });
    write("app/node_modules/@loxaic/own/package.json", { name: "@loxaic/own", version: "0.0.0" });

    const problems = [];
    const found = collectNpm(path.join(root, "app"), new Map(), problems);

    expect([...found.keys()].sort()).toEqual(["a@1.0.0", "b@2.0.0"]);
    expect(found.get("a@1.0.0").text).toBe("MIT text for a");
    expect(found.get("b@2.0.0").license).toBe("MIT (chosen from MIT OR GPL-3.0)");
    // Another platform's optional binary is simply absent; that is not a problem.
    expect(problems).toEqual([]);
  });

  it("walks through our own packages without listing them", () => {
    // The server inlines @loxaic/* into dist/, but their npm dependencies stay
    // external and ship in the deployed node_modules — so they must be listed.
    write("app/package.json", { name: "app", dependencies: { "@loxaic/db": "1" } });
    write("app/node_modules/@loxaic/db/package.json", { name: "@loxaic/db", version: "0.0.0", license: "Apache-2.0", dependencies: { "drizzle-orm": "1" } });
    write("app/node_modules/drizzle-orm/package.json", { name: "drizzle-orm", version: "0.38.4", license: "Apache-2.0" });
    const problems = [];
    const found = collectNpm(path.join(root, "app"), new Map(), problems);
    expect([...found.keys()]).toEqual(["drizzle-orm@0.38.4"]);
    expect(problems).toEqual([]);
  });

  it("reports a required dependency that is not installed instead of skipping it", () => {
    write("app/package.json", { name: "app", dependencies: { missing: "1" } });
    const problems = [];
    collectNpm(path.join(root, "app"), new Map(), problems);
    expect(problems).toEqual([expect.stringContaining("missing (required by app)")]);
  });
});

describe("licenceTextIn", () => {
  it("reads LICENSE, COPYING and NOTICE variants at the package root only", () => {
    write("p/LICENSE.md", "licence");
    write("p/NOTICE", "notice");
    write("p/docs/LICENSE", "not this one");
    write("p/README.md", "nor this");
    expect(licenceTextIn(path.join(root, "p"))).toBe("licence\n\nnotice");
  });
});

describe("collectNative", () => {
  it("attributes every bundled library, extensions to PostgreSQL itself", () => {
    write("native/lib/libz.1.dylib", "");
    write("native/lib/libiconv.2.dylib", "");
    write("native/lib/postgresql/pgcrypto.dylib", "");
    write("native/bin/zlib1.dll", "");
    write("native/lib/amcheck.dll", "");
    // A Windows build's one lib-prefixed PostgreSQL module, beside the extensions.
    write("native/lib/libpqwalreceiver.dll", "");
    const problems = [];
    const found = collectNative(path.join(root, "native"), manifest, problems);
    const byName = Object.fromEntries(found.map((f) => [f.component.name, f.files.sort()]));
    expect(problems).toEqual([]);
    expect(byName.zlib).toEqual(["libz.1.dylib", "zlib1.dll"]);
    expect(byName["GNU libiconv"]).toEqual(["libiconv.2.dylib"]);
    expect(byName.PostgreSQL).toEqual(["amcheck.dll", "libpqwalreceiver.dll", "pgcrypto.dylib"]);
  });

  it("lets a manifest entry win over the extension shape", () => {
    // `zlib1.dll` and `wx*.dll` look like PostgreSQL extensions (lib/, no
    // `lib` prefix); if a layout ever puts them there they must stay theirs.
    write("native/lib/zlib1.dll", "");
    write("native/lib/wxbase3210u_vc_x64_custom.dll", "");
    const found = collectNative(path.join(root, "native"), manifest);
    const byName = Object.fromEntries(found.map((f) => [f.component.name, f.files]));
    expect(byName.zlib).toEqual(["zlib1.dll"]);
    expect(byName.wxWidgets).toEqual(["wxbase3210u_vc_x64_custom.dll"]);
    expect(byName.PostgreSQL).toEqual([]);
  });

  it("refuses a library the manifest does not know", () => {
    write("native/lib/libmystery.so.3", "");
    const problems = [];
    collectNative(path.join(root, "native"), manifest, problems);
    expect(problems).toEqual([expect.stringContaining("libmystery.so.3")]);
  });

  it("accounts for every library in the embedded-postgres build installed here", () => {
    // The real package for this machine's platform, found the way the notices
    // build finds it: a new library upstream fails here, on a developer's
    // machine, before it fails a release leg. (require.resolve cannot do it —
    // embedded-postgres does not export its package.json.)
    const desktopDir = path.resolve(licensesDir, "..");
    const pg = [...collectNpm(desktopDir).values()].filter((p) => p.name.startsWith("@embedded-postgres/"));
    expect(pg.length).toBeGreaterThan(0);
    for (const p of pg) {
      const problems = [];
      const found = collectNative(path.join(p.dir, "native"), manifest, problems);
      expect(problems).toEqual([]);
      expect(found.find((f) => f.component.name === "PostgreSQL").files.length).toBeGreaterThan(0);
    }
  });

  it("has a licence text on disk for every manifest entry", () => {
    for (const c of manifest.components) {
      expect(existsSync(path.join(licensesDir, c.text)), c.text).toBe(true);
      for (const m of c.match) expect(() => new RegExp(m)).not.toThrow();
    }
    const referenced = new Set(manifest.components.map((c) => c.text));
    const unreferenced = readdirSync(licensesDir).filter((f) => f.endsWith(".txt") && !referenced.has(f));
    expect(unreferenced).toEqual([]);
  });
});

describe("renderGroup", () => {
  it("prints each distinct text once and never drops a package without one", () => {
    const out = renderGroup("Title", [
      { name: "x", version: "1", license: "MIT", text: "MIT text" },
      { name: "y", version: "2", license: "MIT", text: "MIT   text" },
      { name: "z", version: "3", license: "ISC", text: "" },
    ]);
    expect(out.match(/MIT text/g)).toHaveLength(1);
    expect(out).toContain("x 1 — MIT");
    expect(out).toContain("y 2 — MIT");
    expect(out).toContain("ship no licence file");
    expect(out).toContain("z 3 — ISC");
  });
});
