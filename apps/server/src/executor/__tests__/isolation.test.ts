import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The executor runs on a user's laptop: no Postgres, no server settings, no
 * Fastify. Its module graph must not reach any of them — not because they
 * would fail loudly (packages/db creates its client lazily, so an import
 * would even *succeed*), but because a laptop process that can be made to
 * open the server's database, or read its settings, is a laptop process with
 * the server's secrets in it.
 *
 * Checked statically over the source rather than by importing under vitest,
 * whose module registry would hide the very thing this asserts. `import
 * type` edges are erased at build time and are not counted.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../..");

const FORBIDDEN = [
  { match: (spec: string) => spec.startsWith("@loxaic/db"), why: "the database" },
  { match: (spec: string, from: string) => path.resolve(path.dirname(from), spec) === path.join(srcRoot, "settings.ts"), why: "server settings" },
  { match: (spec: string, from: string) => path.resolve(path.dirname(from), spec) === path.join(srcRoot, "index.ts"), why: "the server entry" },
  { match: (spec: string) => spec === "fastify" || spec.startsWith("@fastify/"), why: "fastify" },
  { match: (spec: string) => spec === "dockerode", why: "dockerode" },
];

const IMPORT_RE = /^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function edgesOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

function walk(entry: string): { visited: Set<string>; offences: string[] } {
  const visited = new Set<string>();
  const offences: string[] = [];
  const queue = [entry];
  for (;;) {
    const file = queue.pop();
    if (file === undefined) break;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of edgesOf(file)) {
      for (const rule of FORBIDDEN) {
        if (rule.match(spec, file)) offences.push(`${path.relative(srcRoot, file)} → ${spec} (${rule.why})`);
      }
      if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  return { visited, offences };
}

describe("the executor's module graph", () => {
  it("never reaches the database, settings, the server entry, fastify, or dockerode", () => {
    const { visited, offences } = walk(path.join(srcRoot, "executor/main.ts"));
    // Sanity: the walk really did traverse into the sandbox layer.
    expect([...visited].some((f) => f.endsWith("sandbox/host-provider.ts"))).toBe(true);
    expect(offences).toEqual([]);
  });
});
