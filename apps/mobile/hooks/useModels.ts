import { useCallback, useEffect, useState } from 'react';
import { getModels, type ModelInfo } from '@shannon/api-client';

export type ModelWindow = {
  /** The window actually in force — the only valid meter denominator. */
  effective: number | null;
  /** The largest window this model could be loaded at. */
  max: number | null;
  /** What the backend really allocated; null when unloaded or unreported. */
  loaded: number | null;
  source: ModelInfo['context_source'] | null;
};

export function useModels(token: string | null) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const fresh = await getModels();
      setModels(fresh);
      setError(false);
    } catch {
      // Leave the previous list in place — the surface just won't refresh this tick.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadedModel = models.find((m) => m.loaded) ?? null;
  const defaultModel = loadedModel ?? models[0] ?? null;
  const getName = useCallback(
    (id: string) => models.find((m) => m.id === id)?.display_name ?? id,
    [models],
  );
  /** Everything the context meter needs to describe — and caveat — the window.
   *
   * Replaces a `getContext` that fell back to a hardcoded 32768, which
   * silently invented a denominator whenever the list hadn't loaded or the id
   * was unknown — and a wrong denominator is indistinguishable from a right
   * one once it's on screen. Every field here can be null, so the UI is forced
   * to handle "we don't know" rather than guess. */
  const getWindow = useCallback(
    (id: string): ModelWindow => {
      const m = models.find((x) => x.id === id);
      if (!m) return { effective: null, max: null, loaded: null, source: null };
      return {
        effective: m.context_tokens,
        max: m.max_context_tokens,
        loaded: m.loaded_context_tokens,
        source: m.context_source,
      };
    },
    [models],
  );
  const isKnown = useCallback((id: string) => models.some((m) => m.id === id), [models]);

  return { models, loading, error, refresh, loadedModel, defaultModel, getName, getWindow, isKnown };
}
