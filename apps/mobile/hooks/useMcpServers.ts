import { useCallback, useEffect, useState } from 'react';
import {
  getMcpServers,
  getMcpCatalog,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  testMcpServer,
  type McpServer,
  type McpServerInput,
  type McpCatalogEntry,
  type McpTestResult,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';
import { describeRequestError } from '@/lib/connection';

export function useMcpServers(token: string | null) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [s, c] = await Promise.all([getMcpServers(), getMcpCatalog()]);
      setServers(s);
      setCatalog(c);
    } catch {
      showToast('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [token, showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: McpServerInput) => {
      const s = await createMcpServer(input);
      setServers((prev) => [s, ...prev]);
      if (input.builtinKey) {
        setCatalog((prev) => prev.map((c) => (c.key === input.builtinKey ? { ...c, configured: true } : c)));
      }
      showToast('MCP server added');
      return s;
    },
    [showToast],
  );

  const update = useCallback(async (id: string, patch: McpServerInput) => {
    const s = await updateMcpServer(id, patch);
    setServers((prev) => prev.map((x) => (x.id === s.id ? s : x)));
    return s;
  }, []);

  // Both are called as `void toggle(…)` from the screen: a throw here was an
  // unhandled rejection, and the switch just snapped back with no word said.
  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await update(id, { enabled });
        showToast(enabled ? 'Server enabled' : 'Server disabled');
      } catch (err) {
        showToast(describeRequestError(err, 'Could not change the server'), 4000);
      }
    },
    [update, showToast],
  );

  const remove = useCallback(
    async (id: string) => {
      const removed = servers.find((s) => s.id === id);
      try {
        await deleteMcpServer(id);
      } catch (err) {
        showToast(describeRequestError(err, 'Could not remove the server'), 4000);
        return;
      }
      setServers((prev) => prev.filter((x) => x.id !== id));
      if (removed?.builtinKey) {
        setCatalog((prev) => prev.map((c) => (c.key === removed.builtinKey ? { ...c, configured: false } : c)));
      }
      showToast('MCP server removed');
    },
    [servers, showToast],
  );

  const test = useCallback(
    async (id: string): Promise<McpTestResult> => {
      const result = await testMcpServer(id);
      // A test refreshes lastConnectedAt/lastError and tool policies — pull
      // the updated row so the card status is current.
      try {
        setServers(await getMcpServers());
      } catch {
        // keep the stale list
      }
      return result;
    },
    [],
  );

  return { servers, catalog, loading, refresh, create, update, toggle, remove, test };
}

export type { McpServer, McpServerInput, McpCatalogEntry, McpTestResult };
