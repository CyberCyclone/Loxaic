import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What the local executor is allowed to touch, and who it says it is.
 *
 * `<dataDir>/executor-roots.json` holds the folders the user chose through
 * the native directory dialog — the *only* way a path gets in here. The
 * renderer cannot write it (there is no IPC that takes a path to add), and
 * neither can the server: the executor reads this file and enforces it on
 * every call, so a hostile host can ask for `~/.ssh` all day and get a
 * refusal (apps/server/src/executor/service.ts). 0600, like secrets.json —
 * not secret, but it is the list of what an agent may read and write.
 *
 * The executor id is the desktop's `instanceId` whenever the install has a
 * config.json; this file's fallback only exists for a launch that was told
 * where to point by env or flags and never wrote one (the e2e harness, a
 * `--remote` launch). Minted once and kept, so a `local` workspace created
 * against this machine keeps resolving to it.
 */
export function rootsPath(dataDir) {
  return path.join(dataDir, "executor-roots.json");
}

export function loadRoots(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(rootsPath(dataDir), "utf8"));
    if (!Array.isArray(parsed.roots)) return [];
    return parsed.roots.filter((r) => typeof r === "string" && path.isAbsolute(r));
  } catch {
    return [];
  }
}

function saveRoots(dataDir, roots) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(rootsPath(dataDir), JSON.stringify({ roots }, null, 2) + "\n", { mode: 0o600 });
  return roots;
}

/** Adds an absolute directory, once. Anything else is refused rather than
 * normalised: a relative path here would resolve against whatever the
 * executor's cwd happens to be. */
export function addRoot(dataDir, dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("a root must be an absolute path");
  }
  const roots = loadRoots(dataDir);
  if (roots.includes(dir)) return roots;
  return saveRoots(dataDir, [...roots, dir]);
}

/** Removes a directory that is currently a root; a no-op for anything else. */
export function removeRoot(dataDir, dir) {
  const roots = loadRoots(dataDir);
  if (!roots.includes(dir)) return roots;
  return saveRoots(dataDir, roots.filter((r) => r !== dir));
}

export function loadOrCreateExecutorId(dataDir) {
  const file = path.join(dataDir, "executor.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    // fall through: create
  }
  const id = randomUUID();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ id }, null, 2) + "\n", { mode: 0o600 });
  return id;
}
