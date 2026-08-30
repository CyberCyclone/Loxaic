import { useCallback, useEffect, useState } from 'react';
import { getConfig, type ConfigResponse } from '@shannon/api-client';

/** Public, unauthenticated sandbox status — mode, availability, why not if
 * not. Every screen that needs to know "can the agent run tools right now"
 * (the agent screen's degraded banner, the read-only settings view for a
 * non-admin) shares this instead of each polling /v1/config on its own. */
export function useServerConfig() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setConfig(await getConfig());
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { config, loading, refresh };
}
