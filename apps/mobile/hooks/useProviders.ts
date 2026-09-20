import { useCallback, useEffect, useState } from 'react';
import {
  createProvider,
  deleteProvider,
  getProviders,
  testProvider,
  updateProvider,
  type BuiltinProvider,
  type InferenceProvider,
  type ProviderInput,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';

/**
 * The LLM backends this deployment can reach.
 *
 * Admin-only on the server, so `token` here is the *admin's* token or null —
 * the screen passes null for a non-admin rather than calling and showing them
 * a 403. Hiding it is presentation; `requireAdmin` on the routes is the
 * boundary.
 */
export function useProviders(token: string | null) {
  const [providers, setProviders] = useState<InferenceProvider[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await getProviders();
      setProviders(list.providers);
      setBuiltin(list.builtin);
    } catch {
      showToast('Failed to load model providers');
    } finally {
      setLoading(false);
    }
  }, [token, showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: ProviderInput) => {
      const p = await createProvider(input);
      setProviders((prev) => [...prev, p]);
      showToast(`Added ${p.name}`);
      return p;
    },
    [showToast],
  );

  const update = useCallback(async (id: string, patch: ProviderInput) => {
    const p = await updateProvider(id, patch);
    setProviders((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    return p;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteProvider(id);
      setProviders((prev) => prev.filter((x) => x.id !== id));
      showToast('Provider removed');
    },
    [showToast],
  );

  const test = useCallback(
    async (id: string) => {
      const result = await testProvider(id);
      // The row carries what the test found, so refetching is what makes the
      // card's own error line agree with the toast.
      await refresh();
      return result;
    },
    [refresh],
  );

  return { providers, builtin, loading, refresh, create, update, remove, test };
}
