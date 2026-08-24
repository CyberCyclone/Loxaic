import { useCallback, useEffect, useState } from 'react';
import { getModels, type ModelInfo } from '@shannon/api-client';

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
  const getContext = useCallback(
    (id: string) => models.find((m) => m.id === id)?.context_tokens ?? 32768,
    [models],
  );
  const isKnown = useCallback((id: string) => models.some((m) => m.id === id), [models]);

  return { models, loading, error, refresh, loadedModel, defaultModel, getName, getContext, isKnown };
}
