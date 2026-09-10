import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stored update-channel preference, on native — where a key that is not
 * in storage.ts's KNOWN_KEYS list is written and then silently never read
 * again after a restart. That trap is the reason this file mocks
 * AsyncStorage and goes through `hydrateStorage()` rather than testing the
 * pref store against a stub: the assertion that matters is that the value
 * survives the hydration path a real app start takes.
 */
const asyncStore = new Map<string, string>();
const platform = { OS: 'ios' as 'web' | 'ios' };

vi.mock('react-native', () => ({
  get Platform() {
    return platform;
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: () => Promise.resolve([...asyncStore.keys()]),
    multiGet: (keys: string[]) => Promise.resolve(keys.map((k) => [k, asyncStore.get(k) ?? null])),
    multiRemove: (keys: string[]) => {
      for (const k of keys) asyncStore.delete(k);
      return Promise.resolve();
    },
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

const { hydrateStorage } = await import('./storage');
const { readUpdateChannel, setUpdateChannel, subscribeUpdateChannel, __resetUpdateChannelForTest } =
  await import('./update-channel');

beforeEach(() => {
  asyncStore.clear();
  __resetUpdateChannelForTest();
});

describe('update channel preference', () => {
  it('defaults to production when nothing is stored', () => {
    expect(readUpdateChannel()).toBe('production');
  });

  it('round-trips beta through a restart', async () => {
    setUpdateChannel('beta');
    expect(readUpdateChannel()).toBe('beta');

    // What a real app start does: a fresh process reads AsyncStorage once
    // through hydrateStorage(), and everything else reads the cache. A key
    // missing from KNOWN_KEYS is dropped here and the setting silently
    // reverts — which is exactly the bug this asserts against.
    __resetUpdateChannelForTest();
    await hydrateStorage();
    expect(readUpdateChannel()).toBe('beta');
  });

  it('switching back to production survives a restart too', async () => {
    setUpdateChannel('beta');
    setUpdateChannel('production');
    __resetUpdateChannelForTest();
    await hydrateStorage();
    expect(readUpdateChannel()).toBe('production');
  });

  it('reads an unrecognised stored value as production', async () => {
    asyncStore.set('loxaic-update-channel', 'canary');
    await hydrateStorage();
    expect(readUpdateChannel()).toBe('production');
  });

  it('notifies subscribers on change, and stops after unsubscribe', () => {
    // The settings row and the launch-time update check both read this, so a
    // change made in one has to reach the other.
    const seen: string[] = [];
    const unsubscribe = subscribeUpdateChannel(() => { seen.push(readUpdateChannel()); });

    setUpdateChannel('beta');
    expect(seen).toEqual(['beta']);

    unsubscribe();
    setUpdateChannel('production');
    expect(seen).toEqual(['beta']);
  });
});
