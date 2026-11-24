/**
 * The bundled town list (data/cities15000.tsv, GeoNames, CC BY 4.0), read the
 * first time a location is named and kept for the life of the process. Found
 * beside the source in development and at `dist/geo-data` in a build, where
 * tsup's `onSuccess` copies it.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTowns, type Towns } from "./nearest.ts";

const FILE = "cities15000.tsv";

/** Where the file is, in a build or beside the source. Exported for the test
 * that checks a build will find it. */
export function townsFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "geo-data", FILE), path.join(here, "data", FILE)];
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
}

let loading: Promise<Towns> | null = null;

/** The list, read once. A failed read is not kept, so the next call tries
 * again. */
export function loadTowns(): Promise<Towns> {
  if (loading) return loading;
  const attempt = readFile(townsFile(), "utf8").then(parseTowns);
  loading = attempt;
  attempt.catch(() => {
    // Only the promise that failed is forgotten, never a later one.
    if (loading === attempt) loading = null;
  });
  return attempt;
}
