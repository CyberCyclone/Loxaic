import { useCallback, useEffect, useState } from 'react';
import {
  getUsageStats,
  getStatsSeries,
  getModelStats,
  getConversationStats,
  type StatsRange,
  type UsageStats,
  type StatsSeries,
  type ModelStats,
  type ConversationStats,
} from '@shannon/api-client';

export function useStats(token: string | null, range: StatsRange) {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [series, setSeries] = useState<StatsSeries | null>(null);
  const [models, setModels] = useState<ModelStats[]>([]);
  const [conversations, setConversations] = useState<ConversationStats[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      // Passing `range` (not a precomputed `from`) lets the server derive
      // the previous equivalent window for KPI deltas/sparklines itself.
      const [u, s, m, c] = await Promise.all([
        getUsageStats({ range }),
        getStatsSeries(range),
        getModelStats(range),
        getConversationStats(range, 10),
      ]);
      setUsage(u);
      setSeries(s);
      setModels(m);
      setConversations(c);
    } catch {
      // Leave previous data in place — the surface just won't refresh this tick.
    } finally {
      setLoading(false);
    }
  }, [token, range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { usage, series, models, conversations, loading, refresh };
}
