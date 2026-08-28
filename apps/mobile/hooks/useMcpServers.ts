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
} from '@shannon/api-client';
import { useToastHelper } from './useToastHelper';

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

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await update(id, { enabled });
      showToast(enabled ? 'Server enabled' : 'Server disabled');
    },
    [update, showToast],
  );

  const remove = useCallback(
    async (id: string) => {
      const removed = servers.find((s) => s.id === id);
      await deleteMcpServer(id);
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
