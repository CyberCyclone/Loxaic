import { Plug, Wrench, Pencil, Trash2, CircleCheck, CircleAlert } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import type { McpServer } from '@loxaic/api-client';
import { useServerReachable } from '@/lib/connection';

function statusLine(server: McpServer): { text: string; error: boolean } {
  if (server.lastError) return { text: server.lastError, error: true };
  if (server.lastConnectedAt) {
    return { text: `Connected ${new Date(server.lastConnectedAt).toLocaleString()}`, error: false };
  }
  return { text: 'Not connected yet — run Test', error: false };
}

interface McpServerCardProps {
  server: McpServer;
  testing?: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onTools: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The server follows another connection (GitHub): it has no address or
   * credential of its own to show, and is removed by disconnecting that. */
  linked?: boolean;
}

export function McpServerCard({ server, testing = false, onToggle, onTest, onTools, onEdit, onDelete, linked }: McpServerCardProps) {
  // Toggle, test and delete are requests; Edit and Tools open sheets that say
  // for themselves why they cannot save.
  const reachable = useServerReachable();
  const status = statusLine(server);
  const toolCount = Object.keys(server.knownTools).length;

  return (
    <Box testID={`mcp.serverRow.${server.id}`} className="rounded-md border border-border bg-card p-3">
      <HStack className="items-start justify-between">
        <Pressable onPress={onEdit} className="flex-1 pr-2">
          <HStack space="xs" className="items-center">
            <Text className="font-medium text-foreground" numberOfLines={1}>
              {server.name}
            </Text>
            {server.builtinKey && (
              <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
                built-in
              </Text>
            )}
          </HStack>
          <Text size="xs" className="mt-0.5 text-muted-foreground" numberOfLines={1}>
            {linked
              ? 'Uses your GitHub connection'
              : server.transport === 'stdio'
                ? (server.builtinKey ? 'stdio' : server.command)
                : server.url}
          </Text>
        </Pressable>
        <Switch
          testID={`mcp.serverToggle.${server.id}`}
          value={server.enabled}
          disabled={!reachable}
          onValueChange={onToggle}
        />
      </HStack>

      <HStack space="xs" className="mt-2 items-center">
        <Text size="2xs" className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
          {server.transport}
        </Text>
        {toolCount > 0 && (
          <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
            {toolCount} tool{toolCount === 1 ? '' : 's'}
          </Text>
        )}
        <HStack space="xs" className="flex-1 items-center">
          <Icon
            as={status.error ? CircleAlert : CircleCheck}
            size="2xs"
            className={status.error ? 'text-destructive' : 'text-muted-foreground'}
          />
          <Text size="2xs" className={status.error ? 'flex-1 text-destructive' : 'flex-1 text-muted-foreground'} numberOfLines={1}>
            {status.text}
          </Text>
        </HStack>
      </HStack>

      <HStack space="md" className="mt-3 items-center justify-end border-t border-border pt-2">
        <Pressable
          testID={`mcp.serverTest.${server.id}`}
          onPress={onTest}
          disabled={testing || !reachable}
          className="flex-row items-center gap-1 p-1"
        >
          {testing ? <Spinner size="small" /> : <Icon as={Plug} size="xs" className="text-muted-foreground" />}
          <Text size="xs" className="text-muted-foreground">
            Test
          </Text>
        </Pressable>
        <Pressable testID={`mcp.serverTools.${server.id}`} onPress={onTools} className="flex-row items-center gap-1 p-1">
          <Icon as={Wrench} size="xs" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">
            Tools
          </Text>
        </Pressable>
        <Pressable testID={`mcp.serverEdit.${server.id}`} onPress={onEdit} className="p-1">
          <Icon as={Pencil} size="xs" className="text-muted-foreground" />
        </Pressable>
        {!linked && (
          <Pressable
            testID={`mcp.serverDelete.${server.id}`}
            onPress={onDelete}
            disabled={!reachable}
            className={`p-1 ${reachable ? '' : 'opacity-50'}`}
          >
            <Icon as={Trash2} size="xs" className="text-destructive" />
          </Pressable>
        )}
      </HStack>
    </Box>
  );
}
