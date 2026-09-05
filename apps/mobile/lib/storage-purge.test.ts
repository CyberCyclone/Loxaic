import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pre-rename purge, covered on both platforms.
 *
 * It exists because the Shannon → Loxaic rename moved every key this module
 * owns, leaving the old ones with no reader *and no remover* — including a
 * bearer token and cached message content. So the assertions that matter are
 * the deletions, not the survivals, and both storage backends are mocked
 * because the two halves take genuinely different paths: web enumerates
 * `localStorage`, native has to go through `AsyncStorage.getAllKeys`.
 */
const asyncStore = new Map<string, string>();
const platform = { OS: 'web' as 'web' | 'ios' };

vi.mock('react-native', () => ({
  get Platform() {
    return platform;
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...asyncStore.keys()],
    multiGet: async (keys: string[]) => keys.map((k) => [k, asyncStore.get(k) ?? null]),
    multiRemove: async (keys: string[]) => {
      for (const k of keys) asyncStore.delete(k);
    },
    setItem: async (k: string, v: string) => void asyncStore.set(k, v),
    removeItem: async (k: string) => void asyncStore.delete(k),
  },
}));

const { purgePreRenameKeys, hydrateStorage, getItem } = await import('./storage');

const PRE_RENAME = {
  'shannon-session-token': 'a-still-valid-bearer-token',
  'shannon-session-token:http://host:4100': 'a-scoped-bearer-token',
  'shannon-cache:http://host:4100|user-1|index': '{"conversations":[]}',
  'shannon-theme': 'dark',
};
const CURRENT = {
  'loxaic-theme': 'light',
  'loxaic-smart-routing': '{"enabled":true}',
  'loxaic-cache:http://host:4100|user-1|index': '{"conversations":[]}',
};

describe('purgePreRenameKeys on web', () => {
  const local = new Map<string, string>();

  beforeEach(() => {
    platform.OS = 'web';
    local.clear();
    for (const [k, v] of Object.entries({ ...PRE_RENAME, ...CURRENT })) local.set(k, v);
    globalThis.localStorage = {
      get length() {
        return local.size;
      },
      key: (i: number) => [...local.keys()][i] ?? null,
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
      clear: () => local.clear(),
    } as unknown as Storage;
  });

  it('deletes every pre-rename key, credentials and cached content included', async () => {
    await purgePreRenameKeys();
    for (const key of Object.keys(PRE_RENAME)) expect(local.has(key)).toBe(false);
  });

  it('leaves the current keys untouched', async () => {
    await purgePreRenameKeys();
    for (const [key, value] of Object.entries(CURRENT)) expect(local.get(key)).toBe(value);
  });

  it('is a no-op on an install that never held the old keys', async () => {
    for (const key of Object.keys(PRE_RENAME)) local.delete(key);
    await purgePreRenameKeys();
    expect([...local.keys()].sort()).toEqual(Object.keys(CURRENT).sort());
  });
});

describe('purgePreRenameKeys on native', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    asyncStore.clear();
    for (const [k, v] of Object.entries({ ...PRE_RENAME, ...CURRENT })) asyncStore.set(k, v);
  });

  it('deletes the pre-rename keys and keeps the current ones', async () => {
    await purgePreRenameKeys();
    for (const key of Object.keys(PRE_RENAME)) expect(asyncStore.has(key)).toBe(false);
    for (const [key, value] of Object.entries(CURRENT)) expect(asyncStore.get(key)).toBe(value);
  });

  it('hydrates the settings keys the purge left behind', async () => {
    // Regression guard for the same class of bug the purge fixes: a key that
    // is written but absent from KNOWN_KEYS is never read back on native.
    await purgePreRenameKeys();
    await hydrateStorage();
    expect(getItem('loxaic-smart-routing')).toBe('{"enabled":true}');
    expect(getItem('loxaic-theme')).toBe('light');
  });

  it('survives a storage backend that throws', async () => {
    asyncStore.clear();
    const broken = await import('@react-native-async-storage/async-storage');
    const original = broken.default.getAllKeys;
    broken.default.getAllKeys = async () => {
      throw new Error('AsyncStorage unavailable');
    };
    await expect(purgePreRenameKeys()).resolves.toBeUndefined();
    broken.default.getAllKeys = original;
  });
});
