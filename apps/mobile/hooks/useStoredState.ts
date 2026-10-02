import { useCallback, useEffect, useState } from 'react';
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

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        setJson(key, resolved);
        // After this render: a listener's setState must not run inside another
        // component's updater.
        queueMicrotask(() => {
          for (const l of listeners.get(key) ?? []) l(resolved);
        });
        return resolved;
      });
    },
    [key],
  );
  return [value, update] as const;
}
