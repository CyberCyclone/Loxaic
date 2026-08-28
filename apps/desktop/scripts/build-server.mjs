// Builds the server payload the packaged desktop app ships and spawns:
//   resources/server/dist/       bundled server (tsup, @shannon/* inlined)
//   resources/server/node_modules  real npm deps via `pnpm deploy` (no
//                                  workspace symlinks — Electron can't follow
//                                  them outside the repo)
//   resources/server/drizzle/    migrations copy for MIGRATIONS_DIR
// Run via `pnpm --filter @shannon/desktop build:server`.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const outDir = path.resolve(__dirname, "../resources/server");

function run(args, cwd = repoRoot) {
  console.log(`[build-server] ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
}

run(["pnpm", "--filter", "@shannon/server", "build"]);

rmSync(outDir, { recursive: true, force: true });
// pnpm 10 renamed the pre-v9 deploy behaviour behind --legacy; older versions
// reject the flag, so fall back without it.
try {
  run(["pnpm", "--filter", "@shannon/server", "deploy", "--legacy", "--prod", outDir]);
} catch {
  console.log("[build-server] deploy --legacy failed, retrying without the flag");
  rmSync(outDir, { recursive: true, force: true });
  run(["pnpm", "--filter", "@shannon/server", "deploy", "--prod", outDir]);
}

// pnpm deploy also scaffolds an empty node_modules/.bin tree relative to the
// project dir (apps/server/apps/desktop/…) — remove the stray.
rmSync(path.join(repoRoot, "apps/server/apps"), { recursive: true, force: true });

// Only dist/ + node_modules/ + package.json are needed at runtime. "apps" is
// a prior run's stray that deploy would have copied along as a project file.
for (const extra of ["src", "apps", "tsconfig.json", "tsup.config.ts", "vitest.config.ts"]) {
  rmSync(path.join(outDir, extra), { recursive: true, force: true });
}

const drizzleSrc = path.join(repoRoot, "packages/db/drizzle");
cpSync(drizzleSrc, path.join(outDir, "drizzle"), { recursive: true });

for (const required of ["dist/index.js", "node_modules/fastify", "drizzle/meta/_journal.json"]) {
  if (!existsSync(path.join(outDir, required))) {
    throw new Error(`[build-server] missing ${required} in ${outDir}`);
  }
}
console.log(`[build-server] server payload ready at ${outDir}`);
