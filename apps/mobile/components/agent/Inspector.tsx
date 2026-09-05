import { X, Check, Circle, Loader } from 'lucide-react-native';
import { Switch } from '@/components/ui/switch';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
} from '@/components/ui/actionsheet';
import { ContextBreakdown } from '@/components/context/ContextBreakdown';
import type { ContextView } from '@/hooks/useContextUsage';
import type { ChangedFile } from '@/lib/types';
import type { Todo } from '@loxaic/api-client';

const TODO_ICON: Record<Todo['status'], typeof Check> = {
  completed: Check,
  in_progress: Loader,
  pending: Circle,
};

const TODO_TINT: Record<Todo['status'], string> = {
  completed: 'text-success',
  in_progress: 'text-primary',
  pending: 'text-muted-foreground',
};

export interface McpOverrideControls {
  servers: { id: string; name: string }[];
  disabledIds: string[];
  onToggle: (serverId: string, disabled: boolean) => void;
}

interface InspectorBodyProps {
  todos: Todo[];
  changedFiles: ChangedFile[];
  context: ContextView | null;
  mcp?: McpOverrideControls | null;
  onCompact?: () => void;
  busy?: boolean;
}

function InspectorBody({ todos, changedFiles, context, mcp, onCompact, busy }: InspectorBodyProps) {
  return (
    <VStack space="lg">
      <VStack space="xs">
        <Text size="sm" className="font-semibold text-foreground">
          Todo List
        </Text>
        {todos.length === 0 ? (
          <Text size="xs" className="text-muted-foreground">
            No todos yet
          </Text>
        ) : (
          todos.map((todo, i) => (
            <HStack key={todo.id ?? i} space="xs" className="items-center">
              <Icon as={TODO_ICON[todo.status]} size="xs" className={TODO_TINT[todo.status]} />
              <Text
                size="sm"
                className={todo.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}
              >
                {todo.text}
              </Text>
            </HStack>
          ))
        )}
      </VStack>

      <VStack space="xs">
        <Text size="sm" className="font-semibold text-foreground">
          Changed Files ({changedFiles.length})
        </Text>
        {changedFiles.length === 0 ? (
          <Text size="xs" className="text-muted-foreground">
            No files changed yet
          </Text>
        ) : (
          changedFiles.map((file) => (
            <HStack key={file.path} space="xs" className="items-center">
              <Text size="xs" className="flex-1 text-foreground" numberOfLines={1}>
                {file.path}
              </Text>
              <Text size="xs" className="text-success">
                +{file.adds}
              </Text>
              <Text size="xs" className="text-destructive">
                -{file.dels}
              </Text>
            </HStack>
          ))
        )}
      </VStack>

      {mcp && mcp.servers.length > 0 && (
        <VStack space="xs">
          <Text size="sm" className="font-semibold text-foreground">
            MCP Servers
          </Text>
          {mcp.servers.map((server) => {
            const disabled = mcp.disabledIds.includes(server.id);
            return (
              <HStack key={server.id} className="items-center justify-between">
                <Text size="sm" className="flex-1 pr-2 text-foreground" numberOfLines={1}>
                  {server.name}
                </Text>
                <Switch
                  size="sm"
                  value={!disabled}
                  onValueChange={(on) => { mcp.onToggle(server.id, !on); }}
                />
              </HStack>
            );
          })}
          <Text size="2xs" className="text-muted-foreground">
            Off = this conversation only. Takes effect on the next run.
          </Text>
        </VStack>
      )}

      {context && (
        <VStack space="xs">
          <Text size="sm" className="font-semibold text-foreground">
            Context
          </Text>
          <ContextBreakdown context={context} onCompact={onCompact} busy={busy} />
        </VStack>
      )}
    </VStack>
  );
}

interface InspectorProps {
  open: boolean;
  onClose: () => void;
  wide: boolean;
  todos: Todo[];
  changedFiles: ChangedFile[];
  context: ContextView | null;
  mcp?: McpOverrideControls | null;
  /** Absent in the wide (persistent side-panel) layout's own contract — both
   * layouts accept it identically, it's the caller (agent.tsx) that decides
   * whether pressing it should also dismiss the narrow-layout Actionsheet. */
  onCompact?: () => void;
  busy?: boolean;
}

export function Inspector({ open, onClose, wide, todos, changedFiles, context, mcp, onCompact, busy }: InspectorProps) {
  if (!open) return null;

  if (wide) {
    return (
      <Box className="h-full w-[280px] border-l border-border bg-background">
        <HStack className="items-center justify-between border-b border-border px-3 py-3">
          <Text size="sm" className="font-semibold text-foreground">
            Inspector
          </Text>
          <Pressable onPress={onClose} className="rounded-sm p-1 web:hover:bg-muted/50">
            <Icon as={X} size="sm" className="text-muted-foreground" />
          </Pressable>
        </HStack>
        <Box className="p-3">
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} onCompact={onCompact} busy={busy} />
        </Box>
      </Box>
    );
  }

  return (
    <Actionsheet isOpen={open} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent className="max-h-[75%]">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        <Box className="w-full p-3">
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} onCompact={onCompact} busy={busy} />
        </Box>
      </ActionsheetContent>
    </Actionsheet>
  );
}
