import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { X, Check, Circle, Loader } from 'lucide-react-native';
import { Switch } from '@/components/ui/switch';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
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
import type { GitStatus, SandboxRetention, SandboxRow } from '@loxaic/api-client';
import type { Todo } from '@loxaic/api-client';

/** What the Inspector's Git section needs — computed by the caller
 * (`useGitPanel`), same pattern as `McpOverrideControls` below. `disabled`
 * covers the 409 case (a run is active) as well as an in-flight action of
 * its own, so a click while either is true fails locally instead of round
 * -tripping to a server that would refuse it anyway. */
export interface GitPanelControls {
  status: GitStatus | null;
  disabled: boolean;
  onCommit: (message: string) => void;
  onPush: () => void;
  onOpenPr: (title: string) => void;
}

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

  // A local workspace is the user's own folder on their own machine: no
  // server sandbox, no pause, and nothing Loxaic will ever delete — so none
  // of the retention copy below applies, and saying it would be a lie.
  if (ws.kind === 'local') {
    return (
      <VStack space="xs">
        <Text size="sm" className="font-semibold text-foreground">
          Workspace
        </Text>
        <Text testID="agent.inspector.workspace.kind" size="xs" className="text-foreground">
          Local — {ws.executorName} · {ws.path}
        </Text>
        <Text testID="agent.inspector.workspace.state" size="xs" className="text-muted-foreground">
          {sandbox
            ? `Running directly on ${ws.executorName}, with no sandbox.`
            : `Commands will run directly on ${ws.executorName}, with no sandbox, the first time a tool runs.`}
        </Text>
        <Text testID="agent.inspector.workspace.retention" size="xs" className="text-muted-foreground">
          Your files stay on your machine. Loxaic never deletes this folder.
        </Text>
      </VStack>
    );
  }

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

/**
 * Commit, push, and open a pull request — without leaving the app or asking
 * the model to do it. The agent is told to commit as it goes but never to
 * push or open a PR (see agent/workspace.ts's describeWorkspace): those stay
 * the user's own actions, taken here.
 *
 * Renders nothing until `status` has loaded — there is no useful "empty"
 * state to show before the first fetch resolves, on a scratch workspace, or
 * for an optimistic conversation the server has not assigned an id to yet.
 */
function GitSection({ git }: { git: GitPanelControls }) {
  const [message, setMessage] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const { status, disabled, onCommit, onPush, onOpenPr } = git;
  if (!status) return null;

  const changed = status.changed ?? [];
  const ahead = status.ahead ?? 0;

  return (
    <VStack space="xs">
      <Text size="sm" className="font-semibold text-foreground">
        Git
      </Text>
      <HStack space="xs" className="items-center">
        <Text testID="agent.inspector.git.branch" size="xs" className="font-medium text-foreground" numberOfLines={1}>
          {status.branch}
        </Text>
        {status.cloned && (
          <Text testID="agent.inspector.git.aheadBehind" size="xs" className="text-muted-foreground">
            {ahead} ahead · {status.behind ?? 0} behind {status.baseBranch}
          </Text>
        )}
      </HStack>

      {!status.cloned ? (
        <Text size="xs" className="text-muted-foreground">
          Nothing cloned yet — send a message to start.
        </Text>
      ) : (
        <>
          <Text testID="agent.inspector.git.changed" size="xs" className="text-muted-foreground">
            {changed.length === 0 ? 'No changes' : `${String(changed.length)} file${changed.length === 1 ? '' : 's'} changed`}
          </Text>
          <Input className="border-border bg-card">
            <InputField
              testID="agent.inspector.git.commitMessage"
              placeholder="Commit message"
              value={message}
              onChangeText={setMessage}
              editable={!disabled && changed.length > 0}
            />
          </Input>
          <HStack space="xs">
            <Button
              testID="agent.inspector.git.commit"
              size="sm"
              className="flex-1"
              isDisabled={disabled || changed.length === 0 || message.trim().length === 0}
              onPress={() => {
                onCommit(message.trim());
                setMessage('');
              }}
            >
              {disabled ? <ButtonSpinner /> : <ButtonText>Commit</ButtonText>}
            </Button>
            <Button
              testID="agent.inspector.git.push"
              size="sm"
              variant="outline"
              className="flex-1"
              isDisabled={disabled || ahead === 0}
              onPress={onPush}
            >
              <ButtonText>Push</ButtonText>
            </Button>
          </HStack>
        </>
      )}

      {status.pr ? (
        <Pressable
          testID="agent.inspector.git.prLink"
          onPress={() => {
            const url = status.pr?.url;
            if (url) void Linking.openURL(url);
          }}
        >
          <Text size="xs" className="text-primary">
            Pull request #{status.pr.number} →
          </Text>
        </Pressable>
      ) : (
        status.cloned && (
          <VStack space="xs">
            <Input className="border-border bg-card">
              <InputField
                testID="agent.inspector.git.prTitle"
                placeholder="Pull request title"
                value={prTitle}
                onChangeText={setPrTitle}
                editable={!disabled}
              />
            </Input>
            <Button
              testID="agent.inspector.git.openPr"
              size="sm"
              variant="outline"
              isDisabled={disabled || prTitle.trim().length === 0}
              onPress={() => { onOpenPr(prTitle.trim()); }}
            >
              <ButtonText>Open pull request</ButtonText>
            </Button>
          </VStack>
        )
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
  git?: GitPanelControls | null;
  onCompact?: () => void;
  busy?: boolean;
}

function InspectorBody({ todos, changedFiles, context, mcp, workspace, git, onCompact, busy }: InspectorBodyProps) {
  return (
    <VStack space="lg">
      {workspace && <WorkspaceSection workspace={workspace} />}
      {git && <GitSection git={git} />}

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
        <Text testID="agent.inspector.changedFiles.count" size="sm" className="font-semibold text-foreground">
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
  git?: GitPanelControls | null;
  /** Absent in the wide (persistent side-panel) layout's own contract — both
   * layouts accept it identically, it's the caller (agent.tsx) that decides
   * whether pressing it should also dismiss the narrow-layout Actionsheet. */
  onCompact?: () => void;
  busy?: boolean;
}

export function Inspector({ open, onClose, wide, todos, changedFiles, context, mcp, workspace, git, onCompact, busy }: InspectorProps) {
  if (!open) return null;

  if (wide) {
    return (
      <Box testID="agent.inspector.panel" className="h-full w-[280px] border-l border-border bg-background">
        <HStack className="items-center justify-between border-b border-border px-3 py-3">
          <Text size="sm" className="font-semibold text-foreground">
            Inspector
          </Text>
          <Pressable onPress={onClose} className="rounded-sm p-1 web:hover:bg-muted/50">
            <Icon as={X} size="sm" className="text-muted-foreground" />
          </Pressable>
        </HStack>
        {/* The panel's own height is fixed (h-full), but its content keeps
            growing (workspace retention copy, the Git section, todos,
            changed files, context breakdown) — without a scroll container
            a flex column with the gluestack base classes' `min-h-0` lets
            each section shrink below its wrapped-text height instead of
            overflowing, so sections silently render on top of each other. */}
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 12 }}>
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} workspace={workspace} git={git} onCompact={onCompact} busy={busy} />
        </ScrollView>
      </Box>
    );
  }

  return (
    <Actionsheet isOpen={open} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent testID="agent.inspector.panel" className="max-h-[75%]">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        <ScrollView style={{ width: '100%', flex: 1, minHeight: 0 }} contentContainerStyle={{ width: '100%', padding: 12 }}>
          <InspectorBody todos={todos} changedFiles={changedFiles} context={context} mcp={mcp} workspace={workspace} git={git} onCompact={onCompact} busy={busy} />
        </ScrollView>
      </ActionsheetContent>
    </Actionsheet>
  );
}
