import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Cross-platform key-value store with a synchronous in-memory cache.
 *
 * Web uses localStorage directly (kept key-compatible with the old Vite app:
 * loxaic-theme, loxaic-settings, …). Native reads go through the cache,
 * which `hydrateStorage()` fills from AsyncStorage once at app start —
 * await it before first render (the root layout does, behind the font gate).
 */
const cache = new Map<string, string>();

const KNOWN_KEYS = [
  'loxaic-theme',
  'loxaic-settings',
  'loxaic-endpoint',
  'loxaic-selected-model',
  'loxaic-smart-routing',
  'loxaic-thinking-levels',
  'loxaic-update-channel',
] as const;

/**
 * Prefixes whose keys are discovered at hydration rather than listed above.
 *
 * The fixed list can't hold the message cache: its keys are per endpoint, per
 * user, and per conversation, so they aren't known until they exist. A key
 * written under one of these prefixes is read back on native like any other;
 * a key that is neither listed nor prefixed is written and then silently
 * never read again, which is the trap this rule exists to close.
 */
const KNOWN_PREFIXES = ['loxaic-cache:', 'loxaic-session-token:'] as const;

function isKnownKey(key: string): boolean {
  return (
    (KNOWN_KEYS as readonly string[]).includes(key) ||
    KNOWN_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export async function hydrateStorage(): Promise<void> {
  if (Platform.OS === 'web') return;
  // getAllKeys, then filter — AsyncStorage has no prefix query, and reading
  // every key would pull in whatever other libraries have stored.
  const all = await AsyncStorage.getAllKeys();
  const wanted = all.filter(isKnownKey);
  if (wanted.length === 0) return;
  const pairs = await AsyncStorage.multiGet(wanted);
  for (const [key, value] of pairs) {
    if (value != null) cache.set(key, value);
  }
}

/**
 * Keys written by pre-rename (Shannon-branded) releases, purged once at start.
 *
 * The rename moved every key this module owns, so nothing reads these again —
 * but nothing *removes* them either. `removeItem` is only ever called with a
 * key some code path still knows, and no code path knows these any more. Left
 * alone they sit on disk for the life of the install: a valid bearer token in
 * web `localStorage`, and cached message content that `clearCacheForEndpoint`
 * — the detach path, whose whole job is dropping a host's data — can no longer
 * see, because it scans the `loxaic-cache:` prefix.
 *
 * Purged rather than migrated, deliberately. The rename is a clean break, and
 * carrying a credential across it would be a worse answer than signing in
 * once more, which the upgrade notes already promise.
 *
 * Native tokens live in SecureStore, which has no key enumeration, so
 * `purgePreRenameToken` in `auth.ts` handles that half by exact key.
 */
const PRE_RENAME_PREFIX = 'shannon-';

export async function purgePreRenameKeys(): Promise<void> {
  if (Platform.OS === 'web') {
    for (const key of keysWithPrefix(PRE_RENAME_PREFIX)) removeItem(key);
    return;
  }
  try {
    // Not keysWithPrefix: that reads the hydration cache, which by design
    // only ever holds known (post-rename) keys, so it can never see these.
    const stale = (await AsyncStorage.getAllKeys()).filter((key) =>
      key.startsWith(PRE_RENAME_PREFIX),
    );
    if (stale.length === 0) return;
    for (const key of stale) cache.delete(key);
    await AsyncStorage.multiRemove(stale);
  } catch {
    // A failed purge must never block the splash — it retries next launch.
  }
}

/** Every stored key under a prefix — the cache's own eviction needs this, and
 * detach needs it to drop one endpoint's data without touching another's. */
export function keysWithPrefix(prefix: string): string[] {
  if (Platform.OS === 'web') {
    try {
      const out: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const key = globalThis.localStorage.key(i);
        if (key?.startsWith(prefix)) out.push(key);
      }
      return out;
    } catch {
      return [];
    }
  }
  return [...cache.keys()].filter((key) => key.startsWith(prefix));
}

export function getItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return cache.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      /* private mode etc. */
    }
    return;
  }
  cache.set(key, value);
  void AsyncStorage.setItem(key, value);
}

export function removeItem(key: string): void {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  cache.delete(key);
  void AsyncStorage.removeItem(key);
}

export function getJson<T>(key: string, fallback: T): T {
  const raw = getItem(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  setItem(key, JSON.stringify(value));
}
