import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHANNELS } from "./state.js";

/**
 * Which updates this install follows, at `<dataDir>/updates.json`.
 *
 * Its own file rather than a key in config.json, because `buildConfig()`
 * rebuilds that object from a fixed set of keys and drops everything else —
 * a channel stored there would survive until the next time anyone touched a
 * server setting, and then silently revert. This also keeps the choice
 * through a detach, which is right: the channel is a fact about the binary
 * on this machine, not about the server it happens to point at.
 *
 * 0600 like the other files this directory holds. Not a secret; simply
 * nobody else's business which builds this machine takes.
 */
export function updatesPath(dataDir) {
  return path.join(dataDir, "updates.json");
}

/** Anything unrecognised — a hand-edited file, a channel from a future
 * version — reads as production, the conservative half of the choice. */
export function loadChannel(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(updatesPath(dataDir), "utf8"));
    return CHANNELS.includes(parsed.channel) ? parsed.channel : "production";
  } catch {
    return "production";
  }
}

export function saveChannel(dataDir, channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown update channel: ${String(channel)}`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(updatesPath(dataDir), JSON.stringify({ channel }, null, 2) + "\n", { mode: 0o600 });
  return channel;
}
