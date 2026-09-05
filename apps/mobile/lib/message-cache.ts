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

const PREFIX = 'loxaic-cache:';

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
  /** conversationId → recency (the conversation's own updatedAt, or the write
   * clock as a fallback), so eviction can rank without a key scan. */
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
 * When a conversation was last active, for ordering and eviction.
 *
 * The conversation's own `updatedAt`, never the cache's write clock. `at`
 * records when *we* wrote the row, and the caller writes the server's list
 * newest-first — so keying on `at` made the newest thread the earliest write,
 * i.e. the first evicted, and could invert the sidebar (and auto-open the
 * oldest thread) whenever the write loop crossed a millisecond boundary. The
 * write clock is kept only as a fallback for a row that never carried one.
 */
function recency(entry: { meta: { updatedAt?: string }; at: number }): number {
  const ts = entry.meta.updatedAt ? Date.parse(entry.meta.updatedAt) : NaN;
  return Number.isFinite(ts) ? ts : entry.at;
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
    .sort((a, b) => recency(b) - recency(a))
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
  // The index holds each conversation's recency (see `recency`), so eviction
  // can rank without reading every row back.
  index.entries[conversation.id] = recency({ meta, at });

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
 * Remember which user this endpoint was last signed in as.
 *
 * The cache is scoped per user, but the user id comes from the server — so
 * when the server is unreachable, which is exactly when the cache matters,
 * there is nothing to scope by. Storing it locally closes that circle. It
 * lives under the endpoint's own cache prefix, so detaching clears it along
 * with everything else it belongs to.
 *
 * Not a credential and not a claim: it only selects which local snapshot to
 * show. Every request still carries the real token, and the server decides.
 */
export function rememberUserId(endpoint: string, userId: string): void {
  setJson(`${PREFIX}${endpoint.replace(/\/+$/, '')}|user`, userId);
}

export function lastUserId(endpoint: string): string | null {
  return getJson<string | null>(`${PREFIX}${endpoint.replace(/\/+$/, '')}|user`, null);
}

/**
 * Forget one conversation — what a local delete calls.
 *
 * Without it, a thread the user deleted came straight back from the cache on
 * the next offline start, full history and all, possibly as the auto-opened
 * one; the only other pruning path (`writeCachedList`) needs a *successful*
 * list fetch, which is exactly what offline doesn't have.
 */
export function removeCachedConversation(endpoint: string, userId: string, conversationId: string): void {
  const scope = scopeOf(endpoint, userId);
  removeItem(convKey(scope, conversationId));
  const key = indexKey(scope);
  const index = getJson<CacheIndex>(key, { entries: {} });
  index.entries = Object.fromEntries(Object.entries(index.entries).filter(([id]) => id !== conversationId));
  setJson(key, index);
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
