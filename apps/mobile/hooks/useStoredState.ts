import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, setJson } from '@/lib/storage';

/** Every mounted copy of a key, so a write reaches the others. */
const listeners = new Map<string, Set<(value: unknown) => void>>();

/**
 * useState persisted through lib/storage (localStorage on web, AsyncStorage
 * cache on native). Replacement for the Vite app's useLocalStorage hook.
 *
 * Every component calling it with the same key sees the same value: a write
 * from one is pushed to the rest. Each used to hold its own copy, so the
 * default thinking level saved in Settings did not reach an open chat until
 * the chat remounted — a choice that looked ignored.
 */
export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => getJson<T>(key, initial));

  useEffect(() => {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    const listener = (next: unknown) => {
      setValue(next as T);
    };
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }, [key]);

  // The latest value, so an update can be resolved outside a state updater:
  // an updater must be pure (React may run it twice, or for a render it then
  // discards), and this one would otherwise write storage and notify others.
  const latest = useRef(value);
  latest.current = value;

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(latest.current) : next;
      // Two updates in one tick must chain, not both start from the old value.
      latest.current = resolved;
      setValue(resolved);
      setJson(key, resolved);
      for (const l of listeners.get(key) ?? []) l(resolved);
    },
    [key],
  );
  return [value, update] as const;
}
