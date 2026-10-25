// What `pnpm deploy` is allowed to leave in the packaged server payload.
//
// `apps/server` has no `files` field, so `pnpm deploy` copies everything in it that npm would
// not ignore — and a checkout that has run the dev server has `llama/` (downloaded GGUF models,
// 17 GB for one Gemma) and `uploads/` (users' files) beside the source. Both landed in
// `resources/server` and then in the `.app`: three copies of the model on one disk, and an
// installer that would have shipped it. CI never sees them, which is why only a developer's
// local `package` run did.
//
// An allowlist, not a list of known offenders: the next thing the dev server writes into its own
// directory is exactly as unforeseen as `llama/` was.
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Everything the packaged server runs from. `drizzle/` and `sandbox/` are added after this runs.
export const PAYLOAD_KEEP = new Set(["dist", "node_modules", "package.json"]);

// What the packaged server cannot start without. build-server.mjs checks the payload it built,
// and builder-variants.cjs's afterPack (checkPackagedApp) checks the copy inside the app, because
// electron-builder can drop part of a resource on the way in (26 drops any `node_modules` at a
// source's root).
//
// dist/executor.js is the local executor the desktop spawns for Local
// workspaces (supervisor/executor.js); `ws` is its one runtime dependency.
// node-forge builds the GitHub egress proxy's certificates: without it the
// proxy cannot start, and sandboxes have no GitHub. yaml parses every skill's
// frontmatter, the built-ins included: without it no skill loads at all.
// tar-stream writes a custom image's home into its container before start
// (sandbox/container-engine.ts, which the executor bundles too): without it
// neither process loads. playwright-core drives web_fetch's browser fallback
// and carries the installer that downloads its Chromium (browser/install.ts):
// without it the admin's Install button has nothing to run.
export const PAYLOAD_REQUIRED = ["dist/index.js", "dist/executor.js", "dist/reset-password.js", "node_modules/fastify", "node_modules/ws", "node_modules/playwright-core", "node_modules/node-forge", "node_modules/yaml", "node_modules/tar-stream", "drizzle/meta/_journal.json", "sandbox/sandbox.Dockerfile", "sandbox/sandbox/extract.py"];

/** The entries of PAYLOAD_REQUIRED that are not under `dir`. */
export function missingFromPayload(dir) {
  return PAYLOAD_REQUIRED.filter((required) => !existsSync(path.join(dir, required)));
}

/** Removes every top-level entry of `dir` that the payload does not need; returns their names. */
export function pruneToPayload(dir) {
  const removed = [];
  for (const entry of readdirSync(dir)) {
    if (PAYLOAD_KEEP.has(entry)) continue;
    // `rmSync` on a symlink removes the link, never what it points at.
    rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
