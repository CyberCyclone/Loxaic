import { createHash } from "node:crypto";
import type { PromptCacheLossReason, PromptCacheView } from "@loxaic/types";

/**
 * Keeping a conversation's KV cache across a host-model reload: the decisions,
 * pure. The effects (the router's `/slots`, the files) are slot-store.ts.
 *
 * llama.cpp keeps every conversation's KV cache inside the model's own child
 * process, so a reload throws all of them away and the next turn of a 200K
 * conversation re-reads it — ten minutes and more on Pheonix. A reload that
 * changes nothing the cached keys and values were computed with (a sampling
 * setting, a restart, an unload and load again) does not have to: llama.cpp
 * writes a slot's state to a file (`POST /slots/:id?action=save`, under
 * `slot-save-path`) and reads it back into a slot of a new process.
 *
 * Measured on b11457 (Pheonix, 2026-10-22), and why each rule below exists:
 * - The file holds the main model's state only: neither the slot's context
 *   checkpoints nor the MTP head's cache. A hybrid model (Qwen3.6, Qwen3.8,
 *   Flash-Next — every model on Pheonix) cannot roll back without a
 *   checkpoint, so after a restore only a request that *extends* the saved
 *   tokens reuses them. A raw save ends in the reply as generated — reasoning
 *   included — while the next turn replays it without, so it diverged and
 *   re-read everything. The slot is therefore warmed first with the history
 *   ending in that reply (the stage switch's warm-up, `maxTokens: 1`), which
 *   leaves exactly the prefix the next turn extends: 4,299 of 4,326 tokens
 *   reused after a reload, the same as with no reload at all.
 * - The cached keys were rotated for one RoPE and computed by one set of
 *   weights at one cache type; restoring them under anything else would give
 *   wrong answers, not an error. `cacheIdentity` is what must match.
 */

/**
 * Preset keys that change nothing a saved cache was computed with: how the
 * model samples, where its layers sit, how many requests it batches, how it
 * drafts. Every other key — a new one, an admin's extra option nobody has
 * looked at — is part of the identity, so an unknown key can only cost a
 * re-read, never a wrong restore.
 *
 * `ctx-size` is here because a stage without YaRN changes only the window:
 * a cache too big for a smaller one is refused by llama.cpp at restore (and
 * the turn re-reads). A YaRN stage writes `rope-scale` and friends, which are
 * not here, and the stage index is in the identity besides.
 */
export const CACHE_NEUTRAL_KEYS: ReadonlySet<string> = new Set([
  "temp", "top-k", "top-p", "min-p", "repeat-penalty", "presence-penalty", "frequency-penalty", "seed",
  "threads", "threads-batch", "batch-size", "ubatch-size",
  "n-gpu-layers", "n-cpu-moe", "kv-offload", "load-mode", "lazy-mode", "device",
  "parallel", "kv-unified", "cache-ram", "ctx-size",
  "spec-draft-n-max", "spec-draft-p-min", "spec-draft-sampling", "spec-draft-device",
  "log-verbosity",
]);

/** `key = value` lines of a preset section, without its header or comments. */
export function presetEntries(lines: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("[")) continue;
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv) out.push([kv[1], kv[2]]);
  }
  return out;
}

export interface IdentityInput {
  /** The model's section as rendered into the preset (`modelSection`). */
  section: readonly string[];
  /** The `[*]` lines every model gets: the admin's global extra options. */
  globalLines: readonly string[];
  /** The llama.cpp build: its install key and archive hash. */
  build: string;
  /** The active context stage. */
  stage: number;
}

/** What a saved cache must match to be restored. Order-free, and blind to the
 * cache-neutral keys. */
export function cacheIdentity(input: IdentityInput): string {
  // A model's own key beats the same key in `[*]` (llama.cpp's precedence).
  const merged = new Map(presetEntries(input.globalLines));
  for (const [k, v] of presetEntries(input.section)) merged.set(k, v);
  const kept = [...merged].filter(([k]) => !CACHE_NEUTRAL_KEYS.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, build: input.build, stage: input.stage, keys: kept }))
    .digest("hex");
}

// ── Which slot holds which conversation ─────────────────────────────────────

export interface SlotView {
  id: number;
  /** Tokens the slot holds, or null when llama.cpp did not say (a slot that
   * has never run a task). */
  tokens: number | null;
  busy: boolean;
  /** The slot's last prompt as text, which llama.cpp reports beside it: what
   * tells apart two conversations whose turns cost the same. */
  text: string | null;
}

export interface ConversationUse {
  conversationId: string;
  /** The last turn's prompt plus its reply, from `usage_records`. */
  tokens: number;
  at: number;
}

/** How far a slot's count may sit from a turn's prompt + reply and still be
 * that turn: llama.cpp keeps every token but the last one generated
 * (4,296 + 366 − 1 = 4,661 measured), and a stopped turn can be one more off. */
export const MATCH_TOLERANCE = 2;

/** Uses whose last turn could have left a slot at its count. */
export function usesNear(slot: SlotView, uses: readonly ConversationUse[]): ConversationUse[] {
  if (slot.busy || slot.tokens == null || slot.tokens <= 0) return [];
  const tokens = slot.tokens;
  return uses.filter((u) => Math.abs(u.tokens - 1 - tokens) <= MATCH_TOLERANCE);
}

/** How much of a conversation's last user message is looked for in a slot's
 * prompt: enough to tell two apart, short of anything a template rewrites. */
export const MATCH_TEXT_CHARS = 120;

/**
 * Which conversation each slot holds: the one whose last turn ended at the
 * slot's token count — and, when two could, the one whose last user message
 * (`lastUser`) is in the slot's prompt. A slot nothing explains, or still two,
 * is left out: warming the wrong conversation would save something nobody's
 * next turn extends. A conversation is matched once.
 */
export function matchSlots(
  slots: readonly SlotView[],
  uses: readonly ConversationUse[],
  lastUser: ReadonlyMap<string, string> = new Map(),
): Map<number, string> {
  const out = new Map<number, string>();
  const taken = new Set<string>();
  for (const slot of slots) {
    let near = usesNear(slot, uses);
    if (near.length > 1) {
      near = near.filter((u) => {
        const said = lastUser.get(u.conversationId)?.trim().slice(0, MATCH_TEXT_CHARS);
        return Boolean(said && slot.text?.includes(said));
      });
    }
    if (near.length !== 1) continue;
    const [use] = near;
    if (taken.has(use.conversationId)) continue;
    taken.add(use.conversationId);
    out.set(slot.id, use.conversationId);
  }
  return out;
}

// ── Saved sets ──────────────────────────────────────────────────────────────

export interface SavedEntry {
  conversationId: string;
  /** The file's name in the slot directory (llama.cpp takes a bare name). */
  file: string;
  tokens: number;
  bytes: number;
  /** How long llama.cpp took to write it: a restore elsewhere than Linux
   * estimates its progress from this. */
  saveMs: number;
  savedAt: number;
}

export interface Manifest {
  version: 1;
  model: string;
  identity: string;
  entries: SavedEntry[];
  /** Bytes a save of this model took per token, last measured: what the next
   * save's disk check asks for. Kept here so it outlives a restart. */
  bytesPerToken?: number;
}

/** Saved state is conversation content: kept only this long. */
export const SAVED_TTL_MS = 24 * 60 * 60_000;

/** A manifest read from disk, or null when it is not one. Untrusted: a file
 * name outside `[A-Za-z0-9._-]` would reach llama.cpp's path. */
export function parseManifest(text: string): Manifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<Manifest>;
  if (m.version !== 1 || typeof m.model !== "string" || typeof m.identity !== "string" || !Array.isArray(m.entries)) return null;
  const entries = m.entries.filter(
    (e): e is SavedEntry =>
      typeof e === "object" &&
      typeof e.conversationId === "string" &&
      typeof e.file === "string" &&
      /^[A-Za-z0-9._-]{1,200}$/.test(e.file) &&
      typeof e.tokens === "number" &&
      typeof e.bytes === "number" &&
      typeof e.saveMs === "number" &&
      typeof e.savedAt === "number",
  );
  const perToken = typeof m.bytesPerToken === "number" && m.bytesPerToken > 0 ? m.bytesPerToken : undefined;
  return { version: 1, model: m.model, identity: m.identity, entries, ...(perToken ? { bytesPerToken: perToken } : {}) };
}

// ── How much disk a save needs ──────────────────────────────────────────────

/** Free disk a save must leave behind. */
export const DISK_MARGIN_BYTES = 2 * 1024 ** 3;

/** Per token, when neither a measurement nor the model's shape is known: above
 * anything measured on Pheonix (11–36 KB). */
export const FALLBACK_BYTES_PER_TOKEN = 64 * 1024;

/**
 * What saving `tokens` of a model is expected to take: by the last measured
 * save when there is one, else by the model's own cache shape — its KV cache
 * for that many tokens and one sequence's recurrent state, which is what
 * llama.cpp writes — else the fallback.
 */
export function estimatedSaveBytes(
  tokens: number,
  known: { measuredPerToken?: number | null; shape?: { kvBytes: number; recurrentBytes: number } | null },
): number {
  if (known.measuredPerToken && known.measuredPerToken > 0) return Math.ceil(tokens * known.measuredPerToken);
  if (known.shape && known.shape.kvBytes > 0) return known.shape.kvBytes + known.shape.recurrentBytes;
  return tokens * FALLBACK_BYTES_PER_TOKEN;
}

/** A save skipped for want of disk: what it needed, what was free. */
export interface DiskSkip {
  at: number;
  needBytes: number;
  freeBytes: number;
}

/** The entries still worth keeping: not expired, and for a conversation that
 * still exists. */
export function liveEntries(entries: readonly SavedEntry[], now: number, exists: (conversationId: string) => boolean): SavedEntry[] {
  return entries.filter((e) => now - e.savedAt < SAVED_TTL_MS && exists(e.conversationId));
}

// ── Restore progress ────────────────────────────────────────────────────────

/** `pos:` from a `/proc/<pid>/fdinfo/<fd>` text, or null. */
export function fdinfoPos(text: string): number | null {
  const m = /^pos:\s*(\d+)$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** A restore's progress when the platform cannot say how far llama.cpp has
 * read: elapsed time against how long the save took, never past 95% — the
 * figure is labelled an estimate, and a bar stuck at 100% reads as hung. */
export function estimatedBytes(bytes: number, saveMs: number, elapsedMs: number): number {
  if (bytes <= 0) return 0;
  const expected = Math.max(saveMs, 1);
  return Math.min(Math.floor((elapsedMs / expected) * bytes), Math.floor(bytes * 0.95));
}

// ── What a conversation's next turn will find ───────────────────────────────

export type ReloadReason = PromptCacheLossReason;
export type { PromptCacheView };

export interface ReloadEvent {
  at: number;
  reason: ReloadReason;
}

export interface CacheStateInput {
  /** The conversation's newest turn: its model and its prompt + reply. */
  lastTurn: { model: string; tokens: number; at: number } | null;
  /** The model the next turn will use. */
  model: string;
  /** Whether `model` is a host model (only those have a cache to keep). */
  hostModel: boolean;
  /** This conversation's saved entry for `model`, if its identity matches what
   * the model loads with now. */
  saved: { tokens: number } | null;
  /** The newest unload of `model` this server caused or saw. */
  lastReload: ReloadEvent | null;
  /** This conversation's save, skipped for lack of disk, if it was. */
  diskSkip?: DiskSkip | null;
  /** When this server started: every child process is newer than that. */
  bootAt: number;
  /** Tokens per second this model evaluates prompts at, when known. */
  prefillRate: number | null;
}

/**
 * What the next turn on `model` will find. `lost` is said only when it is
 * certain — the process that held the cache is gone — and `warm` claims
 * nothing: llama.cpp may still have evicted it for other conversations.
 */
export function promptCacheState(input: CacheStateInput): PromptCacheView {
  const turn = input.lastTurn;
  if (!turn) return { state: "none" };
  if (!input.hostModel || turn.model !== input.model) return { state: "none" };
  if (input.saved) return { state: "saved", tokens: input.saved.tokens };
  const reload: ReloadEvent | null =
    input.lastReload && input.lastReload.at > turn.at
      ? input.lastReload
      : turn.at < input.bootAt
        ? { at: input.bootAt, reason: "restart" }
        : null;
  if (!reload) return { state: "warm" };
  const rate = input.prefillRate;
  const reread_seconds = rate && rate > 0 ? Math.round(turn.tokens / rate) : null;
  // The skip is the reason only when it was this turn's cache it failed to keep.
  const skip = input.diskSkip && input.diskSkip.at >= turn.at ? input.diskSkip : null;
  if (skip) {
    return { state: "lost", reason: "no_disk", tokens: turn.tokens, reread_seconds, need_bytes: skip.needBytes, free_bytes: skip.freeBytes };
  }
  return { state: "lost", reason: reload.reason, tokens: turn.tokens, reread_seconds };
}
