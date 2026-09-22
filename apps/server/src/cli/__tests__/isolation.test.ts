import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dist/reset-password.js` is run by whoever operates the server, with only a
 * DATABASE_URL — from a desktop's `--reset-password`, `docker compose exec`,
 * or a dev shell. It must not load the server: not fastify, not the entry,
 * not the settings, and not `auth/index.ts`, whose better-auth instance reads
 * BETTER_AUTH_SECRET and the whole auth configuration at import. That is what
 * lets it run beside a live server, and on an install whose secrets it has no
 * business reading.
 *
 * Static over the source, like executor/__tests__/isolation.test.ts and for
 * the same reason: importing under vitest would hide the graph. `import type`
 * edges are erased at build time and are not counted.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../..");
const resolvesTo = (spec: string, from: string, target: string) =>
  spec.startsWith(".") && path.resolve(path.dirname(from), spec).replace(/\.ts$/, "") === path.join(srcRoot, target);

const FORBIDDEN = [
  { match: (spec: string) => spec === "fastify" || spec.startsWith("@fastify/"), why: "fastify" },
  { match: (spec: string, from: string) => resolvesTo(spec, from, "index"), why: "the server entry" },
  { match: (spec: string, from: string) => resolvesTo(spec, from, "settings"), why: "server settings" },
  { match: (spec: string, from: string) => resolvesTo(spec, from, "auth/index") || resolvesTo(spec, from, "auth"), why: "the better-auth instance" },
];

const IMPORT_RE = /^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function walk(entry: string): { visited: Set<string>; offences: string[] } {
  const visited = new Set<string>();
  const offences: string[] = [];
  const queue = [entry];
  for (;;) {
    const file = queue.pop();
    if (file === undefined) break;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const spec = m[1];
        for (const rule of FORBIDDEN) {
          if (rule.match(spec, file)) offences.push(`${path.relative(srcRoot, file)} → ${spec} (${rule.why})`);
        }
        if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
      }
    }
  }
  return { visited, offences };
}

describe("the reset-password CLI's module graph", () => {
  it("never reaches fastify, the server entry, settings, or the auth instance", () => {
    const { visited, offences } = walk(path.join(srcRoot, "cli/reset-password.ts"));
    // Sanity: the walk reached the shared module it exists to run.
    expect([...visited].some((f) => f.endsWith("auth/password-reset.ts"))).toBe(true);
    expect(offences).toEqual([]);
  });
});
