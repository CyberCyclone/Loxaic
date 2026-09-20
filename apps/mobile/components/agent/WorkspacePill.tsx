import { FolderGit2, FolderOpen, ChevronDown, Laptop } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { Workspace } from '@loxaic/types';
import type { WorkspaceChoice } from '@/lib/types';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface WorkspacePillProps {
  /** The active run's fixed workspace, or the pending choice for a new one. */
  workspace: Workspace | WorkspaceChoice | null | undefined;
  /** Whether a choice can still be made — only before the first run. */
  editable: boolean;
  onPress: () => void;
}

/** The last segment of a path, for a chip that has no room for the rest.
 * The Inspector's Workspace section shows the whole thing. */
function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** One line saying what the next (or current) run works in. Tappable only
 * while there is no run yet: a workspace cannot change once a conversation
 * has one, so afterwards this is a label, not a control. */
export function WorkspacePill({ workspace, editable, onPress }: WorkspacePillProps) {
  const ws = workspace ?? { kind: 'scratch' as const };
  const label =
    ws.kind === 'github'
      ? `${ws.repo}${'branch' in ws && ws.branch ? ` · ${ws.branch}` : ''}`
      : ws.kind === 'local'
        ? `${ws.executorName} · ${folderName(ws.path)}`
        : 'Empty workspace';
  const icon = ws.kind === 'github' ? FolderGit2 : ws.kind === 'local' ? Laptop : FolderOpen;
  return (
    // `shrink` and `min-w-0` are load-bearing, not tidiness: React Native
    // defaults every view to `flexShrink: 0`, so without them this pill grows
    // to whatever its label needs and overlaps the mode selector beside it —
    // which made "Manual" unclickable for a workspace whose path happened to
    // be long enough (caught by the Electron local-workspace spec, whose temp
    // directory is exactly that).
    <Pressable
      testID="agent.workspace.button"
      onPress={onPress}
      disabled={!editable}
      className={`min-w-0 shrink flex-row items-center justify-end gap-1 rounded-full px-2.5 py-1 ${editable ? 'bg-muted web:hover:bg-muted/70' : 'bg-transparent'}`}
    >
      <HStack space="xs" className="min-w-0 shrink items-center">
        <Icon as={icon} size="xs" className="text-muted-foreground" />
        {/* TRUNCATE_TEXT, not just numberOfLines: on web this Text renders as
            a raw span (components/ui/text/index.web.tsx), so numberOfLines
            never reaches a renderer that would act on it — and the `truncate`
            class that used to stand in for it only half-works, because every
            Text's web base class sets `whitespace-pre-wrap`. See
            lib/truncate.ts. */}
        <Text size="xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
          {label}
        </Text>
        {editable && <Icon as={ChevronDown} size="xs" className="text-muted-foreground" />}
      </HStack>
    </Pressable>
  );
}
