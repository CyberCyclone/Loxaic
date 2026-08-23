import { useCallback, useSyncExternalStore } from 'react';
import { getItem, setItem } from '@/lib/storage';

export type ThemePreference = 'light' | 'dark' | 'system';

const KEY = 'shannon-theme';
const listeners = new Set<() => void>();
let current: ThemePreference = 'dark';
let loaded = false;

function read(): ThemePreference {
  if (!loaded) {
    const stored = getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      current = stored;
    }
    loaded = true;
  }
  return current;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The stored theme preference. Feed the value into GluestackUIProvider's
 * `mode` prop — it applies it via Uniwind.setTheme (and the html class on web).
 */
export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, read, read);
  const setPref = useCallback((p: ThemePreference) => {
    current = p;
    setItem(KEY, p);
    listeners.forEach((l) => l());
  }, []);
  return [pref, setPref];
}
