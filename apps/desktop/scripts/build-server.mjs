// Builds the server payload the packaged desktop app ships and spawns:
//   resources/server/dist/       bundled server (tsup, @loxaic/* inlined)
//   resources/server/node_modules  real npm deps via `pnpm deploy` (no
//                                  workspace symlinks — Electron can't follow
//                                  them outside the repo)
//   resources/server/drizzle/    migrations copy for MIGRATIONS_DIR
// Run via `pnpm --filter @loxaic/desktop build:server`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const outDir = path.resolve(__dirname, "../resources/server");

function run(args, cwd = repoRoot) {
  console.log(`[build-server] ${args.join(" ")}`);
  // On Windows `pnpm` is a `pnpm.cmd` shim, and execFileSync cannot launch one
  // without a shell: PATHEXT resolution is a shell's job, and since Node's fix
  // for CVE-2024-27980 spawning a .cmd/.bat *without* `shell` throws EINVAL —
  // so resolving `pnpm.cmd` and executing it directly is not an escape hatch.
  // The first Windows release leg died here with `spawnSync pnpm ENOENT`.
  //
  // With a shell, the joined command line goes back through cmd.exe, which
  // re-parses `& | < > ( ) ^` as well as whitespace — all legal in a path. So
  // every argument is quoted, not only ones containing a space: inside quotes
  // cmd takes those characters literally. Backslashes before a quote are
  // doubled so the child's own argv parsing (CommandLineToArgvW) cannot read
  // `\"` as an escaped quote. `%NAME%` still expands inside quotes, which no
  // quoting switches off; a `%` in the checkout path is the one way left to
  // break this.
  //
  // The command name itself is left bare, and must be. pnpm.cmd locates its
  // own JS entry through `%~dp0`, and cmd.exe resolves `%~dp0` against the
  // *current directory* when a batch file is invoked by a quoted bare name —
  // so `"pnpm"` went looking for D:\a\Open-Shannon\pnpm\bin\pnpm.cjs, outside
  // the checkout, and died with MODULE_NOT_FOUND. It is always the literal
  // `pnpm` here, which holds nothing cmd could re-parse.
  const win = process.platform === "win32";
  const quote = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const argv = win ? [args[0], ...args.slice(1).map(quote)] : args;
  execFileSync(argv[0], argv.slice(1), { cwd, stdio: "inherit", shell: win });
}

/**
 * Every symlink under `root` whose target lies outside `root`.
 *
 * `pnpm deploy` links the deployed package into its own virtual store —
 * `node_modules/.pnpm/node_modules/@loxaic/server -> ../../../../../../../server`
 * — a *relative* link that climbs back out of the payload into the checkout.
 * In the repo it happens to land on apps/server and resolve. Copied into
 * `Loxaic.app/Contents/Resources/server` it points at nothing. Unsigned
 * packaging never looks, but signing stats every file in the bundle, so the
 * first release to carry a real certificate died on it (ENOENT, inside
 * electron-builder's readDirectoryAndSign). Symlinked directories are not
 * descended into, so a link inside the payload cannot lead the walk out of it.
 */
function escapingLinks(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(dir, readlinkSync(full));
        const rel = path.relative(root, target);
        if (rel.startsWith("..") || path.isAbsolute(rel)) found.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return found;
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

// Nothing at runtime imports the server by its own package name — the server
// *is* dist/ — so a link pointing out of the payload is never load-bearing,
// only a hazard for whatever walks the bundle next.
for (const link of escapingLinks(outDir)) {
  console.log(`[build-server] removing link that escapes the payload: ${path.relative(outDir, link)}`);
  // unlinkSync, not rmSync: rmSync refuses a link whose target is a directory
  // ("Path is a directory") without `recursive`, and `recursive` is not
  // something to point at a path whose target is the checkout. unlink removes
  // the link itself — on Windows too, where libuv removes a directory junction
  // as a link rather than as the directory it names.
  unlinkSync(link);
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
// Checked last so a future step cannot reintroduce one: this fails in seconds
// on any machine, instead of in a release's signing step on one runner.
const escaping = escapingLinks(outDir);
if (escaping.length > 0) {
  throw new Error(`[build-server] links escape the payload: ${escaping.map((l) => path.relative(outDir, l)).join(", ")}`);
}
console.log(`[build-server] server payload ready at ${outDir}`);
