import type { PromptCacheLossReason, PromptCacheStatus, PromptCacheView, PromptProgress, StreamEventKind } from '@loxaic/api-client';
import { formatTokens } from './promptStats';

/**
 * A conversation's KV cache across a host-model reload (the server's
 * llama/slot-cache.ts), as the app says it:
 * - the "Loading cached context" pill while a saved cache goes back in, before
 *   the reply's request (`prompt.cache` events);
 * - the banner above the composer when a reload took the cache, so the next
 *   message will re-read the whole conversation (`GET …/prompt-cache`).
 */

/** Live fold, mirroring the server's: set by `prompt.cache`, gone at its
 * message's first output of any kind. */
export function foldPromptCache(prev: PromptCacheStatus | null, event: StreamEventKind): PromptCacheStatus | null {
  if (event.kind === 'prompt.cache') {
    const { kind: _kind, ...status } = event;
    return status;
  }
  if (
    prev &&
    (event.kind === 'text.delta' || event.kind === 'thinking.delta' || event.kind === 'tool.call' || event.kind === 'message.end') &&
    event.message_id === prev.message_id
  ) {
    return null;
  }
  return prev;
}

export function promptCacheActive(status: PromptCacheStatus | null | undefined): boolean {
  return status?.step === 'restoring';
}

/** Floored, like every percentage here: 99.6% is not done. */
function pct(status: PromptCacheStatus): number | null {
  if (status.bytes_total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((status.bytes_done / status.bytes_total) * 100)));
}

/** "Loading cached context · 63%" ("about 63%" when the server could only
 * estimate), "Cached context loaded · 180k tokens", or why it was not. */
export function promptCacheLabel(status: PromptCacheStatus): string {
  if (status.step === 'failed') return "Couldn't load the cached context, so it is re-read";
  if (status.step === 'restored') return `Cached context loaded · ${formatTokens(status.tokens)} tokens`;
  const p = pct(status);
  if (p === null) return 'Loading cached context';
  return `Loading cached context · ${status.estimated ? 'about ' : ''}${String(p)}%`;
}

/** The bar's figures, in the shape the shared progress bar draws: bytes read
 * of the file. Null when there is nothing to draw (finished, or no size). */
export function promptCacheBar(status: PromptCacheStatus): { progress: PromptProgress } | null {
  if (status.step !== 'restoring' || status.bytes_total <= 0) return null;
  return {
    progress: {
      total_tokens: status.bytes_total,
      cached_tokens: 0,
      processed_tokens: Math.min(status.bytes_done, status.bytes_total),
      elapsed_ms: 0,
      remaining_ms: null,
    },
  };
}

// ── The banner above the composer ───────────────────────────────────────────

const LOSS: Record<PromptCacheLossReason, string> = {
  settings: 'with new settings',
  context_stage: 'at a different context size',
  restart: 'when the server or llama.cpp restarted',
  unload: 'after it was unloaded',
  evicted: 'to make room for another model',
  crash: 'after llama.cpp stopped unexpectedly',
  device_lost: 'after its GPU was reset',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.max(1, Math.round(seconds)))} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${String(h)} h ${String(rest)} min` : `${String(h)} h`;
}

/** Below this the re-read is quick enough that a warning is noise. */
export const BANNER_MIN_TOKENS = 8_000;

export interface PromptCacheBanner {
  /** What a dismissal is remembered by: this conversation, this loss. */
  key: string;
  text: string;
}

/**
 * The banner for `view`, or null: only when the cache is certainly gone, the
 * conversation is big enough for the re-read to matter, no reply is going
 * (that reply is already paying for it), and it was not dismissed.
 */
export function promptCacheBanner(input: {
  conversationId: string;
  view: PromptCacheView | null;
  modelName: string;
  running: boolean;
  dismissed: ReadonlySet<string>;
}): PromptCacheBanner | null {
  const { view } = input;
  if (input.running || view?.state !== 'lost' || view.tokens < BANNER_MIN_TOKENS) return null;
  const key = `${input.conversationId}|${view.reason}|${String(view.tokens)}`;
  if (input.dismissed.has(key)) return null;
  const eta = view.reread_seconds != null && view.reread_seconds > 0 ? ` (about ${formatDuration(view.reread_seconds)})` : '';
  return {
    key,
    text:
      `${input.modelName} was reloaded ${LOSS[view.reason]} since this conversation's last reply, so its prompt cache is gone. ` +
      `Your next message re-reads all ${formatTokens(view.tokens)} tokens${eta}.`,
  };
}
