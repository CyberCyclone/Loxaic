#!/usr/bin/env node
// Rebuild the offline town list the location tool names a place from.
//
//   node apps/server/scripts/build-cities.mjs [download-dir]
//
// Downloads GeoNames' cities15000 (every town of 15,000 people or more), its
// first-level region names and its country names, and writes
// src/geo/data/cities15000.tsv: name, region, country, latitude, longitude,
// one town a line, in GeoNames id order so a refresh diffs cleanly. The files
// are kept in `download-dir` (default: a new temporary directory) and only
// read, never run.
//
// Data from GeoNames (https://www.geonames.org), licensed CC BY 4.0. The
// attribution is written into the file's header and into data/NOTICE.md, and
// the app's location settings show it.
//
// Needs `unzip` on PATH.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://download.geonames.org/export/dump";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../src/geo/data/cities15000.tsv");
const dir = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), "geonames-"));
mkdirSync(dir, { recursive: true });

async function download(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${String(res.status)}`);
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const zip = await download("cities15000.zip");
const cities = execFileSync("unzip", ["-p", zip, "cities15000.txt"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const admin1 = new Map(
  readFileSync(await download("admin1CodesASCII.txt"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([code, name]) => [code, name]),
);
const countries = new Map(
  readFileSync(await download("countryInfo.txt"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .map((f) => [f[0], f[4]]),
);

// Tabs and line breaks never occur in GeoNames names, but a field must never
// be able to break a line of this file.
const clean = (s) => (s ?? "").replace(/[\t\r\n]/g, " ").trim();

const rows = cities
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"))
  .map((f) => ({
    id: Number(f[0]),
    name: clean(f[1]),
    region: clean(admin1.get(`${f[8]}.${f[10]}`) ?? ""),
    country: clean(countries.get(f[8]) ?? f[8]),
    lat: Number(f[4]).toFixed(4),
    lon: Number(f[5]).toFixed(4),
  }))
  .filter((r) => r.name && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
  .sort((a, b) => a.id - b.id);

const header = [
  `# Towns of 15,000 people or more, from GeoNames cities15000, downloaded ${new Date().toISOString().slice(0, 10)}.`,
  "# Contains data from GeoNames (https://www.geonames.org), licensed under CC BY 4.0",
  "# (https://creativecommons.org/licenses/by/4.0/). Rebuilt by apps/server/scripts/build-cities.mjs.",
  "# name\tregion\tcountry\tlatitude\tlongitude",
];
writeFileSync(out, [...header, ...rows.map((r) => [r.name, r.region, r.country, r.lat, r.lon].join("\t"))].join("\n") + "\n");
console.log(`wrote ${String(rows.length)} towns to ${out} (downloads in ${dir})`);
