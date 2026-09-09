// Builds the server payload the packaged desktop app ships and spawns:
//   resources/server/dist/       bundled server (tsup, @loxaic/* inlined)
//   resources/server/node_modules  real npm deps via `pnpm deploy` (no
//                                  workspace symlinks — Electron can't follow
//                                  them outside the repo)
//   resources/server/drizzle/    migrations copy for MIGRATIONS_DIR
// Run via `pnpm --filter @loxaic/desktop build:server`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const outDir = path.resolve(__dirname, "../resources/server");

function run(args, cwd = repoRoot) {
  console.log(`[build-server] ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
}

run(["pnpm", "--filter", "@loxaic/server", "build"]);

rmSync(outDir, { recursive: true, force: true });
// pnpm 10 renamed the pre-v9 deploy behaviour behind --legacy; older versions
// reject the flag, so fall back without it.
try {
  run(["pnpm", "--filter", "@loxaic/server", "deploy", "--legacy", "--prod", outDir]);
} catch {
  console.log("[build-server] deploy --legacy failed, retrying without the flag");
  rmSync(outDir, { recursive: true, force: true });
  run(["pnpm", "--filter", "@loxaic/server", "deploy", "--prod", outDir]);
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

// Lets a packaged install (which has no repo checkout) auto-build the agent
// sandbox image on first use — see SANDBOX_BUILD_CONTEXT in
// container-provider.ts. Podman/Docker still need to be installed
// separately; this only ships the recipe.
// The *whole* context, not just the Dockerfile: it `COPY`s sandbox/extract.py,
// and container-provider hashes every file here into the image tag. Shipping
// the Dockerfile alone produced a context that could not build (the COPY
// failed) and a tag that silently degraded to `:base` — which is what a
// packaged app hit the first time anything asked it to build the image, in
// the local container-isolation stage.
cpSync(path.join(repoRoot, "infra/docker"), path.join(outDir, "sandbox"), {
  recursive: true,
  filter: (src) => !src.endsWith("server.Dockerfile"),
});

// dist/executor.js is the local executor the desktop spawns for Local
// workspaces (supervisor/executor.js); `ws` is its one runtime dependency.
for (const required of ["dist/index.js", "dist/executor.js", "node_modules/fastify", "node_modules/ws", "drizzle/meta/_journal.json", "sandbox/sandbox.Dockerfile", "sandbox/sandbox/extract.py"]) {
  if (!existsSync(path.join(outDir, required))) {
    throw new Error(`[build-server] missing ${required} in ${outDir}`);
  }
}
console.log(`[build-server] server payload ready at ${outDir}`);
