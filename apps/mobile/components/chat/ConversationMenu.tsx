import { EllipsisVertical, Trash2 } from 'lucide-react-native';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

interface ConversationMenuProps {
  /** testID namespace, and which word the delete item uses. */
  area: 'chat' | 'agent';
  onDelete: () => void;
}

/**
 * The header's overflow menu — the far-right ⋮ on a conversation.
 *
 * Rendered only for a conversation's owner, because deleting is its only item
 * and that is owner-only (the server refuses it for anyone else, silently). An
 * empty menu would be worse than no menu; when this gains an item a guest may
 * use, the gate moves from the caller onto the items.
 *
 * Deleting opens a confirmation rather than deleting: the caller owns that
 * dialog, so the sheet's Delete and this one say the same thing about what
 * this deployment does with a deleted conversation.
 */
export function ConversationMenu({ area, onDelete }: ConversationMenuProps) {
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
      <MenuItem
        key="delete"
        textValue="Delete"
        testID={`${area}.header.delete`}
        onPress={onDelete}
        className="gap-2"
      >
        <Icon as={Trash2} size="sm" className="text-destructive" />
        <MenuItemLabel className="text-destructive">
          {area === 'agent' ? 'Delete run' : 'Delete chat'}
        </MenuItemLabel>
      </MenuItem>
    </Menu>
  );
}
