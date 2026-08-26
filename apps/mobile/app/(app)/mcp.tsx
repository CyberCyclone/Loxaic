import { useState } from 'react';
import { FlatList } from 'react-native';
import { Plus } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { McpServerCard } from '@/components/mcp/McpServerCard';
import { McpCatalogCard } from '@/components/mcp/McpCatalogCard';
import { McpServerModal } from '@/components/mcp/McpServerModal';
import { McpToolsSheet } from '@/components/mcp/McpToolsSheet';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useMcpServers } from '@/hooks/useMcpServers';
import { useSettings } from '@/hooks/useSettings';
import { useToastHelper } from '@/hooks/useToastHelper';
import { useSession } from '@/lib/session';
import type { McpServer, McpServerInput, McpCatalogEntry } from '@shannon/api-client';

type Row =
  | { type: 'catalog'; entry: McpCatalogEntry }
  | { type: 'server'; server: McpServer };

export default function McpScreen() {
  const shell = useShell();
  const { token } = useSession();
  const { servers, catalog, loading, create, update, toggle, remove, test } = useMcpServers(token);
  const { showToast } = useToastHelper();
  const [settings] = useSettings();
  const devMode = !!settings.devMode;
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [toolsFor, setToolsFor] = useState<McpServer | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditing(server);
    setModalOpen(true);
  };

  const handleSave = async (input: McpServerInput) => {
    if (editing) {
      await update(editing.id, input);
    } else {
      await create(input);
    }
  };

  const handleTest = async (server: McpServer) => {
    setTestingId(server.id);
    try {
      const result = await test(server.id);
      if (result.ok) {
        showToast(
          result.changedTools.length > 0
            ? `Connected — ${result.tools.length} tools (${result.changedTools.length} changed, approvals reset)`
            : `Connected — ${result.tools.length} tools`,
        );
      } else {
        showToast(`Connection failed: ${result.error}`, 5000);
      }
    } catch {
      showToast('Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  const rows: Row[] = [
    // Dev tooling stays hidden until the user turns dev mode on.
    ...catalog
      .filter((c) => !c.configured && (!c.dev || devMode))
      .map((entry) => ({ type: 'catalog' as const, entry })),
    ...servers.map((server) => ({ type: 'server' as const, server })),
  ];

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="MCP Servers"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
        right={
          <Button size="sm" className="bg-primary" onPress={openCreate}>
            <ButtonIcon as={Plus} className="text-primary-foreground" />
            <ButtonText className="text-primary-foreground">Add</ButtonText>
          </Button>
        }
      />

      {loading && rows.length === 0 ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner />
        </Box>
      ) : rows.length === 0 ? (
        <Box className="flex-1 items-center justify-center p-6">
          <Text className="mb-2 text-center text-foreground">No MCP servers yet</Text>
          <Text size="sm" className="mb-4 text-center text-muted-foreground">
            Connect Model Context Protocol servers to give the agent new tools — search, APIs, your own
            services. Every tool asks for approval until you allow it.
          </Text>
          <Pressable onPress={openCreate} className="rounded-full bg-primary px-4 py-2">
            <Text className="text-primary-foreground">Add your first server</Text>
          </Pressable>
        </Box>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => (row.type === 'catalog' ? `catalog-${row.entry.key}` : row.server.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          ItemSeparatorComponent={() => <Box className="h-2" />}
          renderItem={({ item }) =>
            item.type === 'catalog' ? (
              <McpCatalogCard entry={item.entry} onEnable={create} />
            ) : (
              <McpServerCard
                server={item.server}
                testing={testingId === item.server.id}
                onToggle={(enabled) => toggle(item.server.id, enabled)}
                onTest={() => handleTest(item.server)}
                onTools={() => setToolsFor(item.server)}
                onEdit={() => openEdit(item.server)}
                onDelete={() => remove(item.server.id)}
              />
            )
          }
        />
      )}

      <McpServerModal open={modalOpen} onClose={() => setModalOpen(false)} onSave={handleSave} editing={editing} />
      <McpToolsSheet server={toolsFor} onClose={() => setToolsFor(null)} test={test} update={update} />
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
