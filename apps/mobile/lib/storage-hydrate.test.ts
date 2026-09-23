import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStore = new Map<string, string>();

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: () => Promise.resolve([...asyncStore.keys()]),
    multiGet: (keys: string[]) => Promise.resolve(keys.map((k) => [k, asyncStore.get(k) ?? null])),
    setItem: (k: string, v: string) => {
      asyncStore.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k: string) => {
      asyncStore.delete(k);
      return Promise.resolve();
    },
  },
}));

const { hydrateStorage, getItem } = await import('./storage');

describe('hydrateStorage on native', () => {
  beforeEach(() => {
    asyncStore.clear();
    asyncStore.set('loxaic-theme', 'light');
    asyncStore.set('loxaic-smart-routing', '{"enabled":true}');
  });

  it('reads back the settings keys it wrote', async () => {
    // A key written but absent from KNOWN_KEYS is never read back on native.
    await hydrateStorage();
    expect(getItem('loxaic-smart-routing')).toBe('{"enabled":true}');
    expect(getItem('loxaic-theme')).toBe('light');
  });
});
