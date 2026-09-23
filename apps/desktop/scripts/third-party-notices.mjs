#!/usr/bin/env node
// Writes resources/THIRD_PARTY_NOTICES.txt: the licence of everything the
// packaged desktop app redistributes that is not Loxaic's own code. MIT, BSD,
// Apache and the LGPL all make shipping the notice a condition of shipping the
// binary, and electron-builder collects none of them.
//
// What ends up in the app, and so what is listed:
//   - the server payload's node_modules (resources/server, from build-server.mjs)
//   - the desktop's own production dependencies (electron-updater, embedded-postgres…)
//   - the web client's dependencies, which the Expo export bundles into its JS.
//     This is a superset — it includes native-only modules the web bundle never
//     imports — because over-attributing costs a few lines and under-attributing
//     is the thing this file exists to prevent
//   - the shared libraries embedded-postgres bundles beside PostgreSQL, which
//     ship with no licence text at all (licenses/native-libraries.json)
//   - the Go modules and Go runtime compiled into the tsnet-proxy sidecar, when
//     the sidecar was built
// Electron's LICENSE and Chromium's LICENSES.chromium.html ship beside this
// file as they are (builder-variants.cjs's extraResources), not repeated here.
//
// Run after build-server.mjs (it reads the deployed payload). No dependencies
// of its own: this runs inside the release job, before anything is signed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "../..");

/** Our own packages are covered by the repository's LICENSE, not listed here. */
const OWN_SCOPE = "@loxaic/";

/** Licences we are content to take when a package offers a choice. */
const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "0BSD", "Unlicense", "BlueOak-1.0.0", "CC0-1.0", "Zlib", "Python-2.0"];

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/**
 * The licence a dual-licensed package is used under. "(MIT OR GPL-3.0)" is
 * MIT here; a single licence, or an AND, is reported exactly as declared.
 */
export function chooseLicense(declared) {
  if (!declared) return "UNKNOWN";
  const expr = String(declared).trim().replace(/^\((.*)\)$/, "$1");
  if (!/\sOR\s/.test(expr) || /\sAND\s/.test(expr)) return expr;
  const options = expr.split(/\s+OR\s+/).map((o) => o.trim().replace(/^\(|\)$/g, ""));
  const permissive = options.find((o) => PERMISSIVE.includes(o));
  return permissive ? `${permissive} (chosen from ${expr})` : expr;
}

function declaredLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return undefined;
}

/** The licence and notice files at a package's root, concatenated. */
export function licenceTextIn(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => LICENCE_FILE.test(n)).sort();
  } catch {
    return "";
  }
  return names
    .filter((n) => statSync(path.join(dir, n)).isFile())
    .map((n) => readFileSync(path.join(dir, n), "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Names a licence from its text, for Go modules, which declare none anywhere
 * else. Only the handful of shapes that actually occur; anything unrecognised
 * is reported as such and its text still printed in full.
 */
export function identifyLicence(text) {
  if (!text) return "UNKNOWN";
  const t = text.replace(/\s+/g, " ");
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Mozilla Public License,? (v\. |version )?2\.0/i.test(t)) return "MPL-2.0";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose/i.test(t)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|names of its contributors may be used/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  return "see licence text";
}

/** Node's own lookup: `node_modules/<name>` in `from` or any directory above it. */
function resolvePackageDir(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate));
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Every package reachable through production dependencies from `rootDir`'s
 * package.json, keyed name@version. Missing optional dependencies are the
 * other platforms' binaries and are skipped; a missing required one is
 * reported, because it means the tree on disk is not the one that ships.
 */
export function collectNpm(rootDir, into = new Map(), problems = []) {
  const rootPkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const queue = [{ from: realpathSync(rootDir), pkg: rootPkg }];
  const seenDirs = new Set();
  while (queue.length > 0) {
    const { from, pkg } = queue.shift();
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ];
    for (const { name, optional } of deps) {
      if (name.startsWith(OWN_SCOPE)) continue;
      const dir = resolvePackageDir(name, from);
      if (!dir) {
        if (!optional && !(pkg.optionalDependencies && name in pkg.optionalDependencies)) {
          problems.push(`${name} (required by ${pkg.name ?? rootDir}) is not installed`);
        }
        continue;
      }
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const depPkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const key = `${depPkg.name}@${depPkg.version}`;
      if (!into.has(key)) {
        into.set(key, {
          name: depPkg.name,
          version: depPkg.version,
          license: chooseLicense(declaredLicense(depPkg)),
          text: licenceTextIn(dir),
          dir,
        });
      }
      queue.push({ from: dir, pkg: depPkg });
    }
  }
  return into;
}

const SHARED_LIB = /\.(dylib|dll|so(\.\d+)*)$/i;

function sharedLibraries(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SHARED_LIB.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The components behind embedded-postgres' bundled shared libraries. PostgreSQL
 * itself is always listed; its extension modules (lib/postgresql/*, or a
 * Windows lib/*.dll without a `lib` prefix) are part of it. Anything else must
 * match the manifest, and a library that matches nothing is a problem — the
 * notices are only as good as that list, so a new library upstream has to be
 * noticed rather than shipped unattributed.
 */
export function collectNative(nativeDir, manifest, problems = []) {
  const components = manifest.components.map((c) => ({ ...c, re: c.match.map((m) => new RegExp(m)) }));
  const found = new Map([["PostgreSQL", { component: components.find((c) => c.name === "PostgreSQL"), files: [] }]]);
  for (const file of sharedLibraries(nativeDir)) {
    const base = path.basename(file);
    const rel = path.relative(nativeDir, file).split(path.sep);
    const extension = (rel[0] === "lib" && rel[1] === "postgresql") || (rel[0] === "lib" && rel.length === 2 && !/^lib/i.test(base));
    const component = extension ? components.find((c) => c.name === "PostgreSQL") : components.find((c) => c.re.some((r) => r.test(base)));
    if (!component) {
      problems.push(`${path.relative(nativeDir, file)}: no entry in licenses/native-libraries.json`);
      continue;
    }
    if (!found.has(component.name)) found.set(component.name, { component, files: [] });
    found.get(component.name).files.push(base);
  }
  return [...found.values()];
}

/**
 * The Go modules compiled into the sidecar, plus the Go runtime and standard
 * library, which are compiled in too and carry Go's own BSD licence.
 */
export function collectGo(moduleDir) {
  const out = execFileSync(
    "go",
    ["list", "-deps", "-f", "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}", "./..."],
    { cwd: moduleDir, encoding: "utf8" },
  );
  const modules = new Map();
  for (const line of out.split("\n")) {
    const [modPath, version, dir] = line.split("\t");
    if (!modPath || modules.has(modPath)) continue;
    const text = licenceTextIn(dir);
    modules.set(modPath, { name: modPath, version, license: identifyLicence(text), text, dir });
  }
  const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
  const goVersion = execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim();
  modules.set("go", { name: "Go runtime and standard library", version: goVersion, license: "BSD-3-Clause", text: licenceTextIn(goroot) });
  return [...modules.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

/**
 * One block per distinct licence text, listing every package that ships it:
 * several hundred MIT packages share a handful of texts, and printing each
 * copy would bury the few that differ. Packages that ship no text are listed
 * by their declared licence, never dropped.
 */
export function renderGroup(title, packages) {
  const byText = new Map();
  const noText = [];
  for (const p of packages) {
    if (!p.text) {
      noText.push(p);
      continue;
    }
    const key = p.text.replace(/\s+/g, " ").trim();
    if (!byText.has(key)) byText.set(key, { text: p.text, packages: [] });
    byText.get(key).packages.push(p);
  }
  const lines = [RULE, title, RULE, ""];
  for (const { text, packages: ps } of [...byText.values()].sort((a, b) => a.packages[0].name.localeCompare(b.packages[0].name))) {
    for (const p of ps.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`${p.name} ${p.version ?? ""} — ${p.license}`.trimEnd());
    lines.push("", text, "", THIN, "");
  }
  if (noText.length > 0) {
    lines.push("These packages ship no licence file; each is used under the licence it declares:", "");
    for (const p of noText.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`${p.name} ${p.version ?? ""} — ${p.license}`.trimEnd());
    lines.push("");
  }
  return lines.join("\n");
}

export function renderNative(components, licensesDir) {
  const lines = [RULE, "Libraries bundled with PostgreSQL (embedded-postgres)", RULE, ""];
  for (const { component, files } of components) {
    lines.push(`${component.name} — ${component.license}`);
    if (files.length > 0) lines.push(`Files: ${[...new Set(files)].sort().join(", ")}`);
    lines.push(`Source: ${component.source}`, "", readFileSync(path.join(licensesDir, component.text), "utf8").trim(), "", THIN, "");
  }
  return lines.join("\n");
}

function main() {
  const problems = [];
  const licensesDir = path.join(desktopDir, "licenses");
  const serverDir = path.join(desktopDir, "resources/server");
  if (!existsSync(path.join(serverDir, "package.json"))) {
    throw new Error("[notices] resources/server is missing — run build:server first");
  }

  const bundled = collectNpm(serverDir, new Map(), problems);
  collectNpm(desktopDir, bundled, problems);
  const web = collectNpm(path.join(repoRoot, "apps/mobile"), new Map(), problems);
  for (const key of bundled.keys()) web.delete(key);

  const manifest = JSON.parse(readFileSync(path.join(licensesDir, "native-libraries.json"), "utf8"));
  const pgPackages = [...bundled.values()].filter((p) => p.name.startsWith("@embedded-postgres/"));
  const native = pgPackages.flatMap((p) => {
    const nativeDir = path.join(p.dir, "native");
    return existsSync(nativeDir) ? collectNative(nativeDir, manifest, problems) : [];
  });
  if (pgPackages.length === 0) problems.push("no @embedded-postgres platform package is installed");

  // The sidecar is optional in a local `package:dir` build, and always built
  // for a release — so list its modules exactly when it is being shipped.
  const sidecarDir = path.join(desktopDir, "resources/tsnet-proxy");
  const sidecarBuilt = existsSync(sidecarDir) && readdirSync(sidecarDir).length > 0;
  const go = sidecarBuilt ? collectGo(path.join(repoRoot, "infra/tsnet-proxy")) : [];
  if (!sidecarBuilt) console.log("[notices] tsnet-proxy was not built; its Go modules are not listed");

  // A package with neither a declared licence nor a licence file is one we
  // cannot say we have the right to ship.
  for (const p of [...bundled.values(), ...web.values(), ...go]) {
    if (!p.text && /^UNKNOWN|^see licence text/.test(p.license)) problems.push(`${p.name}@${p.version}: no licence declared or shipped`);
  }

  if (problems.length > 0) {
    throw new Error(`[notices] cannot account for everything this build ships:\n  ${problems.join("\n  ")}`);
  }

  const header = [
    "Loxaic — third-party notices",
    "",
    "Loxaic is licensed under the Apache License, Version 2.0; its LICENSE and NOTICE",
    "files ship beside this one. This application also includes the third-party",
    "software listed below, each under its own licence. Where a package offers a",
    "choice of licences, the one Loxaic uses it under is named.",
    "",
    "Electron's and Chromium's licences are in LICENSE.electron.txt and",
    "LICENSES.chromium.html, beside this file.",
    "",
  ].join("\n");
  const sections = [
    header,
    renderGroup("npm packages bundled with the server and the desktop app", [...bundled.values()]),
    renderNative(native, licensesDir),
    renderGroup("npm packages compiled into the web client", [...web.values()]),
  ];
  if (go.length > 0) sections.push(renderGroup("Go modules compiled into the Tailscale sidecar (tsnet-proxy)", go));

  const outFile = path.join(desktopDir, "resources/THIRD_PARTY_NOTICES.txt");
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${sections.join("\n")}\n`);
  console.log(
    `[notices] wrote ${path.relative(desktopDir, outFile)}: ${bundled.size} bundled npm packages, ` +
      `${web.size} web-only npm packages, ${native.length} native components, ${go.length} Go modules`,
  );
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main();
}
