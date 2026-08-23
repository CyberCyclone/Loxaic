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

const RANGE_MS: Record<StatsRange, number> = {
  session: 60 * 60 * 1000,
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

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
      const since = new Date(Date.now() - RANGE_MS[range]).toISOString();
      const [u, s, m, c] = await Promise.all([
        getUsageStats({ from: since }),
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
    refresh();
  }, [refresh]);

  return { usage, series, models, conversations, loading, refresh };
}
