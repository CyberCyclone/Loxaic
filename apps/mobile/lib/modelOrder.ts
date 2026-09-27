import type { ModelInfo } from '@/lib/types';

/**
 * Whether a model runs on this deployment's own host (the built-in llama.cpp
 * runtime or another host in the cluster), where loaded-or-not decides how
 * soon it answers. A hosted API model is always "loaded".
 */
export function isHostModel(m: Pick<ModelInfo, 'location'>): boolean {
  return m.location !== 'remote';
}

/** What the picker says about a host model's load state, or null for none. */
export function loadState(m: Pick<ModelInfo, 'location' | 'loaded' | 'loading'>): 'loaded' | 'loading' | null {
  if (!isHostModel(m)) return null;
  if (m.loaded) return 'loaded';
  if (m.loading) return 'loading';
  return null;
}

const RANK = { loaded: 0, loading: 1 } as const;

/**
 * A provider's models with the loaded ones first, then any loading, then the
 * rest — each in the order the server listed them. A loaded host model
 * answers now; any other one waits for a load, which can take a minute and
 * may unload someone else's model to make room. Hosted models keep their
 * order.
 */
export function loadedFirst<T extends Pick<ModelInfo, 'location' | 'loaded' | 'loading'>>(models: T[]): T[] {
  const rank = (m: T) => {
    const s = loadState(m);
    return s ? RANK[s] : 2;
  };
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m);
}
