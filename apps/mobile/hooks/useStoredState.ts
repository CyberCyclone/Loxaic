import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, setJson } from '@/lib/storage';

/**
 * Every mounted hook for a given key, so a write from one component reaches
 * the others. Without this, saving in the Settings modal leaves every screen
 * already reading that key on its old copy until it remounts — which is how a
 * freshly-flipped toggle appears to do nothing.
 */
const listeners = new Map<string, Set<(value: unknown) => void>>();

function broadcast(key: string, value: unknown, self: ((value: unknown) => void) | null): void {
  const subs = listeners.get(key);
  if (!subs) return;
  for (const fn of subs) if (fn !== self) fn(value);
}

/**
 * useState persisted through lib/storage (localStorage on web, AsyncStorage
 * cache on native). Replacement for the Vite app's useLocalStorage hook.
 */
export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => getJson<T>(key, initial));
  const receiveRef = useRef<((value: unknown) => void) | null>(null);

  useEffect(() => {
    const receive = (next: unknown) => setValue(next as T);
    receiveRef.current = receive;
    let subs = listeners.get(key);
    if (!subs) {
      subs = new Set();
      listeners.set(key, subs);
    }
    subs.add(receive);
    // Another instance may have written while this one was unmounted.
    setValue(getJson<T>(key, initial));
    return () => {
      subs!.delete(receive);
      if (subs!.size === 0) listeners.delete(key);
    };
    // `initial` is a fresh literal on most call sites; re-running on it would
    // clobber state every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        setJson(key, resolved);
        // Deferred: notifying sibling hooks synchronously would set state on
        // other components during this one's render phase.
        queueMicrotask(() => broadcast(key, resolved, receiveRef.current));
        return resolved;
      });
    },
    [key],
  );
  return [value, set] as const;
}
