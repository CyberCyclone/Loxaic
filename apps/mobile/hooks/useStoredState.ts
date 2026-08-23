import { useCallback, useState } from 'react';
import { getJson, setJson } from '@/lib/storage';

/**
 * useState persisted through lib/storage (localStorage on web, AsyncStorage
 * cache on native). Replacement for the Vite app's useLocalStorage hook.
 */
export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => getJson<T>(key, initial));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        setJson(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set] as const;
}
