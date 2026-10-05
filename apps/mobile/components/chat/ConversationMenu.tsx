import { Bot, ClipboardList, EllipsisVertical, MessageCircleQuestion, Trash2 } from 'lucide-react-native';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

interface ConversationMenuProps {
  /** testID namespace, and which word the delete item uses. `routineChat` is
   * a routine's chat screen, which has the menu for its sub-agents alone. */
  area: 'chat' | 'agent' | 'routineChat';
  /** Absent for anyone but the owner — deleting is owner-only. */
  onDelete?: () => void;
  /** The newest plan or question set, and how to open it — absent when the
   * conversation has neither (#199). */
  review?: { kind: 'plan' | 'questions'; open: () => void };
  /** Opens the thread's sub-agents list — absent where a thread cannot have
   * any (plain chat). `running` is how many are going now, shown beside it. */
  subAgents?: { open: () => void; running: number };
}

/**
 * The header's overflow menu — the far-right ⋮ on a conversation.
 *
 * Each item is gated by whether its handler was passed, and the menu renders
 * only when at least one was: an empty menu would be worse than no menu.
 * "View plan" / "View questions" is for anyone who can see the conversation; Delete is for its
 * owner only (the server refuses anyone else, silently).
 *
 * Deleting opens a confirmation rather than deleting: the caller owns that
 * dialog, so the sheet's Delete and this one say the same thing about what
 * this deployment does with a deleted conversation.
 */
export function ConversationMenu({ area, onDelete, review, subAgents }: ConversationMenuProps) {
  if (!onDelete && !review && !subAgents) return null;
  const items = [];
  if (subAgents) {
    // Always offered where a thread can have them, running or not: the list is
    // also where a finished sub-agent's transcript is reached from.
    const label = subAgents.running > 0 ? `Sub-agents · ${String(subAgents.running)} running` : 'Sub-agents';
    items.push(
      <MenuItem key="subagents" textValue="Sub-agents" testID={`${area}.header.subAgents`} onPress={subAgents.open} className="gap-2">
        <Icon as={Bot} size="sm" className="text-foreground" />
        <MenuItemLabel>{label}</MenuItemLabel>
      </MenuItem>,
    );
  }
  if (review) {
    // Follows the newest item: after questions are answered and a plan
    // proposed, the plan is what there is to look at.
    const label = review.kind === 'questions' ? 'View questions' : 'View plan';
    items.push(
      <MenuItem key="plan" textValue={label} testID={`${area}.header.viewPlan`} onPress={review.open} className="gap-2">
        <Icon as={review.kind === 'questions' ? MessageCircleQuestion : ClipboardList} size="sm" className="text-foreground" />
        <MenuItemLabel>{label}</MenuItemLabel>
      </MenuItem>,
    );
  }
  if (onDelete) {
    items.push(
      <MenuItem key="delete" textValue="Delete" testID={`${area}.header.delete`} onPress={onDelete} className="gap-2">
        <Icon as={Trash2} size="sm" className="text-destructive" />
        <MenuItemLabel className="text-destructive">{area === 'agent' ? 'Delete run' : 'Delete chat'}</MenuItemLabel>
      </MenuItem>,
    );
  }
  return (
    <Menu
      placement="bottom right"
      offset={4}
      // The trigger is a render prop; the testID has to land on the Pressable
      // it returns rather than on the Icon inside it, which renders through a
      // third-party Svg layer that never emits one.
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          testID={`${area}.header.menu`}
          accessibilityLabel="Conversation actions"
          className="rounded-sm p-1.5 web:hover:bg-muted/50"
        >
          <Icon as={EllipsisVertical} size="sm" className="text-foreground" />
        </Pressable>
      )}
    >
      {items}
    </Menu>
  );
}
