import { useCallback, useEffect, useState } from 'react';
import {
  getConversationRetention,
  updateConversationRetention,
  type ConversationRetentionSettings,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';

/** Admin-only: what this deployment does with a conversation its owner
 * deleted. Mirrors useInferenceSettings; `token` gates the fetch since the
 * route 403s for anyone else. */
export function useConversationRetention(token: string | null) {
  const [settings, setSettings] = useState<ConversationRetentionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setSettings(await getConversationRetention());
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: { keepDeleted?: boolean; keepDeletedDays?: number }) => {
      const previous = settings;
      try {
        setSettings(await updateConversationRetention(patch));
      } catch (err) {
        // Put the control back where it was: a switch that stayed flipped
        // after a refused write would claim this deployment keeps deleted
        // conversations when it does not.
        setSettings(previous);
        showToast(err instanceof Error ? err.message : 'Failed to update retention', 4000);
      }
    },
    [settings, showToast],
  );

  return { settings, loading, refresh, update };
}
