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
import type { ChangedFile, Workspace, WorkspaceChoice } from '@/lib/types';
import { describeRetention, formatDeadline } from '@/lib/retention';
import type { SandboxRetention, SandboxRow } from '@loxaic/api-client';
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

export interface WorkspaceView {
  retention: SandboxRetention;
  /** The conversation's sandbox, or null when it has not run a tool yet. */
  sandbox: SandboxRow | null;
  /** What the workspace is — the run's fixed one, or the pending choice for
   * a run not yet started. Null/undefined is scratch. */
  workspace?: Workspace | WorkspaceChoice | null;
}

/**
 * What the user is told about where their work lives, and for how long.
 *
 * Shown before anything is at stake rather than after: the retention line is
 * present from the first message, so someone deciding whether to spend an
 * afternoon in an agent chat can see the terms first. Once a workspace exists
 * and has been paused, it also says when it would actually be deleted — the
 * in-app half of the warning that issue #5 will eventually also push.
 */
function WorkspaceSection({ workspace }: { workspace: WorkspaceView }) {
  const { retention, sandbox } = workspace;
  const ws = workspace.workspace ?? { kind: 'scratch' as const };
  const paused = sandbox?.status === 'stopped';
  return (
    <VStack space="xs">
      <Text size="sm" className="font-semibold text-foreground">
        Workspace
      </Text>
      {ws.kind === 'github' ? (
        <Text testID="agent.inspector.workspace.kind" size="xs" className="text-foreground">
          {ws.repo}
          {'branch' in ws && ws.branch ? ` · ${ws.branch}` : ''}
          {'baseBranch' in ws && ws.baseBranch ? ` (from ${ws.baseBranch})` : ''}
        </Text>
      ) : (
        <Text testID="agent.inspector.workspace.kind" size="xs" className="text-foreground">
          Empty workspace
        </Text>
      )}
      {sandbox ? (
        <Text testID="agent.inspector.workspace.state" size="xs" className="text-muted-foreground">
          {paused
            ? 'Paused — your files are kept. The next message starts it again.'
            : 'Running on the server.'}
        </Text>
      ) : (
        <Text testID="agent.inspector.workspace.state" size="xs" className="text-muted-foreground">
          No workspace yet — one is created the first time a tool runs.
        </Text>
      )}
      {/* `size="xs"`, not the `2xs` the rest of this panel uses: `text-2xs` has
          no token in the Tailwind v4 theme, so on web it compiles to nothing at
          all — no font size and no line height — and a wrapping paragraph of it
          overlaps whatever follows. Harmless for the one-line hints elsewhere,
          not for these. */}
      <Text testID="agent.inspector.workspace.retention" size="xs" className="text-muted-foreground">
        {describeRetention(retention)}
      </Text>
      {sandbox?.reap_at && (
        <Text testID="agent.inspector.workspace.deadline" size="xs" className="text-warning">
          Deleted {formatDeadline(sandbox.reap_at)} unless this conversation is used again.
        </Text>
      )}
    </VStack>
  );
}

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
  workspace?: WorkspaceView | null;
  onCompact?: () => void;
  busy?: boolean;
}

function InspectorBody({ todos, changedFiles, context, mcp, workspace, onCompact, busy }: InspectorBodyProps) {
  return (
    <VStack space="lg">
      {workspace && <WorkspaceSection workspace={workspace} />}

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
  workspace?: WorkspaceView | null;
  /** Absent in the wide (persistent side-panel) layout's own contract — both
   * layouts accept it identically, it's the caller (agent.tsx) that decides
   * whether pressing it should also dismiss the narrow-layout Actionsheet. */
  onCompact?: () => void;
  busy?: boolean;
}

export function Inspector({ open, onClose, wide, todos, changedFiles, context, mcp, workspace, onCompact, busy }: InspectorProps) {
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
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} workspace={workspace} onCompact={onCompact} busy={busy} />
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
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} workspace={workspace} onCompact={onCompact} busy={busy} />
        </Box>
      </ActionsheetContent>
    </Actionsheet>
  );
}
