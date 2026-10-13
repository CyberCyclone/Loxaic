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
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Everything the packaged server runs from. `drizzle/` and `sandbox/` are added after this runs.
export const PAYLOAD_KEEP = new Set(["dist", "node_modules", "package.json"]);

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
