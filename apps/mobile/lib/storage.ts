import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Cross-platform key-value store with a synchronous in-memory cache.
 *
 * Web uses localStorage directly (kept key-compatible with the old Vite app:
 * shannon-theme, shannon-settings, …). Native reads go through the cache,
 * which `hydrateStorage()` fills from AsyncStorage once at app start —
 * await it before first render (the root layout does, behind the font gate).
 */
const cache = new Map<string, string>();

const KNOWN_KEYS = [
  'shannon-theme',
  'shannon-settings',
  'shannon-endpoint',
  'shannon-selected-model',
] as const;

export async function hydrateStorage(): Promise<void> {
  if (Platform.OS === 'web') return;
  const pairs = await AsyncStorage.multiGet([...KNOWN_KEYS]);
  for (const [key, value] of pairs) {
    if (value != null) cache.set(key, value);
  }
}

export function getItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return cache.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(key, value);
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
      globalThis.localStorage?.removeItem(key);
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
