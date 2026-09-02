import { getJson, keysWithPrefix, removeItem, setJson } from './storage';
import type { Conversation, Message } from './types';

/**
 * A local snapshot of what the server last told us, so a client can show its
 * conversations while the host is unreachable.
 *
 * **Deliberately not `packages/sync`.** That module's op-log and last-writer-
 * wins merge were designed for device-side *editing* — a client that composes
 * offline and reconciles later. It was never wired into the client, and this
 * is a far smaller thing: a read-only display copy. Nothing here merges,
 * resolves, or replays; the server is the only writer, and a successful fetch
 * replaces a conversation's entry wholesale. If offline *sending* is ever
 * built, that is when the op-log becomes the right tool — not now.
 *
 * Scoping is per endpoint **and** per user. Two people using one desktop
 * install must not see each other's threads in the sidebar, and the same
 * account on two different hosts has two genuinely different sets of
 * conversations.
 */

const PREFIX = 'shannon-cache:';

/** Conversations kept per (endpoint, user). Beyond this the least recently
 * written are dropped — a cache that grows forever eventually costs more than
 * the offline read it enables, particularly on AsyncStorage. */
const MAX_CONVERSATIONS = 50;

/** Messages kept per conversation, newest-first in the source list. Enough to
 * read the recent thread offline; not the whole history, which the server
 * still owns. */
const MAX_MESSAGES = 100;

interface CachedConversation {
  meta: Omit<Conversation, 'msgs'>;
  msgs: Message[];
  /** Last write, for LRU eviction. */
  at: number;
}

interface CacheIndex {
  /** conversationId → last write, so eviction needs no key scan. */
  entries: Record<string, number>;
}

function scopeOf(endpoint: string, userId: string): string {
  // The endpoint is normalized so http://host:4100 and http://host:4100/ are
  // one scope rather than two half-filled ones.
  return `${PREFIX}${endpoint.replace(/\/+$/, '')}|${userId}`;
}

function indexKey(scope: string): string {
  return `${scope}|index`;
}

function convKey(scope: string, conversationId: string): string {
  return `${scope}|c|${conversationId}`;
}

/**
 * Everything cached for this scope, newest first — what the sidebar renders
 * before (or instead of) a successful fetch.
 */
export function readCachedConversations(endpoint: string, userId: string): Conversation[] {
  const scope = scopeOf(endpoint, userId);
  const index = getJson<CacheIndex>(indexKey(scope), { entries: {} });
  return Object.keys(index.entries)
    .map((id) => getJson<CachedConversation | null>(convKey(scope, id), null))
    .filter((entry): entry is CachedConversation => !!entry)
    .sort((a, b) => b.at - a.at)
    .map((entry) => ({ ...entry.meta, msgs: entry.msgs }));
}

/**
 * Replace one conversation's cached copy.
 *
 * Wholesale, never merged: the server is the source of truth, and a merge
 * here would invent a state that never existed on it — the exact failure mode
 * that makes a stale cache worse than no cache.
 */
export function writeCachedConversation(
  endpoint: string,
  userId: string,
  conversation: Conversation,
): void {
  const scope = scopeOf(endpoint, userId);
  const { msgs, ...meta } = conversation;
  const at = Date.now();

  setJson(convKey(scope, conversation.id), {
    meta,
    // Keep the newest, which is what a reader lands on.
    msgs: msgs.slice(-MAX_MESSAGES),
    at,
  } satisfies CachedConversation);

  const key = indexKey(scope);
  const index = getJson<CacheIndex>(key, { entries: {} });
  index.entries[conversation.id] = at;

  const ids = Object.keys(index.entries);
  if (ids.length > MAX_CONVERSATIONS) {
    const doomed = ids
      .sort((a, b) => (index.entries[a] ?? 0) - (index.entries[b] ?? 0))
      .slice(0, ids.length - MAX_CONVERSATIONS);
    // Rebuilt rather than deleted key-by-key: a dynamic `delete` on an index
    // signature is both slower and disallowed by the lint config.
    const doomedSet = new Set(doomed);
    index.entries = Object.fromEntries(
      Object.entries(index.entries).filter(([id]) => !doomedSet.has(id)),
    );
    for (const id of doomed) removeItem(convKey(scope, id));
  }
  setJson(key, index);
}

/** Cache a whole list at once, dropping entries the server no longer lists —
 * a conversation deleted elsewhere must not linger in the sidebar forever. */
export function writeCachedList(
  endpoint: string,
  userId: string,
  conversations: Conversation[],
): void {
  const scope = scopeOf(endpoint, userId);
  const live = new Set(conversations.map((c) => c.id));
  const index = getJson<CacheIndex>(indexKey(scope), { entries: {} });
  const stale = Object.keys(index.entries).filter((id) => !live.has(id));
  for (const id of stale) removeItem(convKey(scope, id));
  index.entries = Object.fromEntries(
    Object.entries(index.entries).filter(([id]) => live.has(id)),
  );
  setJson(indexKey(scope), index);
  for (const conversation of conversations) {
    writeCachedConversation(endpoint, userId, conversation);
  }
}

/**
 * Drop everything cached for one endpoint — every user of it.
 *
 * What detach calls. Scoped to the endpoint on purpose: someone who leaves
 * one host and joins another must not lose the other host's cache, and the
 * data being cleared belongs to a server they no longer have access to.
 */
export function clearCacheForEndpoint(endpoint: string): void {
  const prefix = `${PREFIX}${endpoint.replace(/\/+$/, '')}|`;
  for (const key of keysWithPrefix(prefix)) removeItem(key);
}
