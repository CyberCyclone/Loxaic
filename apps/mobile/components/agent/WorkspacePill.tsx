import { FolderGit2, FolderOpen, ChevronDown } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { Workspace } from '@loxaic/types';
import type { WorkspaceChoice } from '@/lib/types';

interface WorkspacePillProps {
  /** The active run's fixed workspace, or the pending choice for a new one. */
  workspace: Workspace | WorkspaceChoice | null | undefined;
  /** Whether a choice can still be made — only before the first run. */
  editable: boolean;
  onPress: () => void;
}

/** One line saying what the next (or current) run works in. Tappable only
 * while there is no run yet: a workspace cannot change once a conversation
 * has one, so afterwards this is a label, not a control. */
export function WorkspacePill({ workspace, editable, onPress }: WorkspacePillProps) {
  const ws = workspace ?? { kind: 'scratch' as const };
  const label = ws.kind === 'github' ? `${ws.repo}${'branch' in ws && ws.branch ? ` · ${ws.branch}` : ''}` : 'Empty workspace';
  const icon = ws.kind === 'github' ? FolderGit2 : FolderOpen;
  return (
    <Pressable
      testID="agent.workspace.button"
      onPress={onPress}
      disabled={!editable}
      className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${editable ? 'bg-muted web:hover:bg-muted/70' : 'bg-transparent'}`}
    >
      <HStack space="xs" className="items-center">
        <Icon as={icon} size="xs" className="text-muted-foreground" />
        <Text size="xs" className="text-muted-foreground" numberOfLines={1}>
          {label}
        </Text>
        {editable && <Icon as={ChevronDown} size="xs" className="text-muted-foreground" />}
      </HStack>
    </Pressable>
  );
}
