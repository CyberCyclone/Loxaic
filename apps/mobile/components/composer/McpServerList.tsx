import { router } from 'expo-router';
import { Settings2 } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { McpSwitches } from '@/hooks/useMcpSwitches';

/**
 * The connected MCP servers with a switch each, for this conversation only.
 * Rendered by the composer's `+` menu on every platform (a submenu on the
 * web, a page of the sheet on native).
 */
export function McpServerList({ mcp, onNavigate }: { mcp: McpSwitches; onNavigate?: () => void }) {
  const manage = () => {
    onNavigate?.();
    router.push('/mcp');
  };

  return (
    <VStack testID="composer.mcp.list" className="min-w-0">
      {mcp.loading && mcp.rows.length === 0 ? (
        <Box className="items-center py-4">
          <Spinner />
        </Box>
      ) : mcp.rows.length === 0 ? (
        <Box testID="composer.mcp.empty" className="px-3 py-3">
          <Text size="sm" className="text-foreground">No MCP servers are switched on.</Text>
          <Text size="xs" className="mt-1 text-muted-foreground">Add one, or turn one on, in MCP Servers.</Text>
        </Box>
      ) : (
        mcp.rows.map((row) => (
          <HStack
            key={row.id}
            testID={`composer.mcp.server.${row.id}`}
            className="min-w-0 items-center gap-3 rounded-md px-3 py-2"
          >
            <VStack className="min-w-0 flex-1">
              <HStack className="min-w-0 items-center gap-1.5">
                {row.lastError ? (
                  <Box
                    testID={`composer.mcp.error.${row.id}`}
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                  />
                ) : null}
                <Text size="sm" className="min-w-0 shrink text-foreground" style={TRUNCATE_TEXT}>
                  {row.name}
                </Text>
              </HStack>
              <Text size="2xs" className="text-muted-foreground">
                {row.toolCount > 0 ? `${String(row.toolCount)} tools` : 'Tools not listed yet'}
                {row.explicit ? ' · this chat' : ''}
              </Text>
            </VStack>
            <Switch
              testID={`composer.mcp.toggle.${row.id}`}
              size="sm"
              value={row.on}
              disabled={!mcp.canToggle}
              onValueChange={(on) => { mcp.toggle(row.id, on); }}
            />
          </HStack>
        ))
      )}
      {mcp.lockedReason ? (
        <Text testID="composer.mcp.locked" size="2xs" className="px-3 pb-1 text-muted-foreground">
          {mcp.lockedReason}
        </Text>
      ) : mcp.rows.length > 0 ? (
        <Text size="2xs" className="px-3 pb-1 text-muted-foreground">
          This chat only. Takes effect from your next message.
        </Text>
      ) : null}
      <Box className="my-1 h-px bg-border" />
      <Pressable
        testID="composer.mcp.manage"
        onPress={manage}
        className="flex-row items-center gap-2 rounded-md px-3 py-2 hover:bg-muted"
      >
        <Icon as={Settings2} size="xs" className="text-muted-foreground" />
        <Text size="sm" className="text-foreground">Manage MCP servers</Text>
      </Pressable>
    </VStack>
  );
}
