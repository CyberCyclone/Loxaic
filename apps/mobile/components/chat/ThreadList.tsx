import { useState } from 'react';
import { FlatList } from 'react-native';
import { Plus, GitFork, Pencil, Download, Trash2, X, Users } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Badge, BadgeText } from '@/components/ui/badge';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
  ActionsheetItem,
  ActionsheetItemText,
  ActionsheetIcon,
} from '@/components/ui/actionsheet';
import { isOwner, type Conversation } from '@/lib/types';

/** The button in the header's corner. Defaults to "new chat"; a routine has no
 * such thing, so it offers "Run now" in the same place instead. */
export interface ThreadListNewAction {
  icon: React.ComponentProps<typeof Icon>['as'];
  testID: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

interface ThreadListProps {
  title: string;
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat?: () => void;
  /** Replaces the new-chat button entirely — same slot, same corner. */
  newAction?: ThreadListNewAction;
  /** Omitted where forking is meaningless: a routine's chats are a record of
   * what it ran, and a fork of one belongs to no routine. */
  onFork?: (id: string) => void;
  /** Omitted where the title is not the user's to choose — a routine names its
   * own chats after itself, and a rename is local-only anyway. */
  onRename?: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  /** Opens the share sheet. Omitted on surfaces that don't support sharing. */
  onShare?: (id: string) => void;
  /**
   * A second line for a row, replacing the kind badge.
   *
   * A routine's chats all carry the same title, so without this every row of
   * its history reads identically and there is nothing to pick between them.
   */
  rowMeta?: (c: Conversation) => { badge: string; danger?: boolean; time: string } | null;
}

// Web's thread-row actions only appear on hover, which the design's own
// mobile breakpoint just hides entirely — there's no working touch fallback
// to port. Long-press → Actionsheet is the natural replacement.
export function ThreadList({
  title,
  conversations,
  activeId,
  onSelect,
  onNewChat,
  newAction,
  onFork,
  onRename,
  onDelete,
  onShare,
  rowMeta,
}: ThreadListProps) {
  const [search, setSearch] = useState('');
  const [actionsFor, setActionsFor] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameText, setRenameText] = useState('');

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <VStack className="h-full w-[280px] border-r border-border bg-background">
      <HStack className="items-center justify-between px-3 py-3">
        <Text size="sm" className="font-semibold text-foreground">
          {title}
        </Text>
        <Pressable
          testID={newAction?.testID ?? 'threadList.newChat'}
          accessibilityLabel={newAction?.label ?? 'New chat'}
          onPress={newAction?.onPress ?? onNewChat}
          disabled={newAction?.disabled}
          className={`rounded-sm p-1 web:hover:bg-muted/50 ${newAction?.disabled ? 'opacity-40' : ''}`}
        >
          <Icon as={newAction?.icon ?? Plus} size="sm" className="text-foreground" />
        </Pressable>
      </HStack>

      <Box className="px-3 pb-2">
        <Input className="border-border bg-card">
          <InputField placeholder="Search..." value={search} onChangeText={setSearch} />
        </Input>
      </Box>

      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
        renderItem={({ item }) => (
          <Pressable
            testID={`threadList.item.${item.id}`}
            onPress={() => { onSelect(item.id); }}
            onLongPress={() => { setActionsFor(item); }}
            className={`mb-1 rounded-md p-2.5 ${
              activeId === item.id ? 'bg-muted' : 'web:hover:bg-muted/40'
            }`}
          >
            <Text size="sm" className="font-medium text-foreground" numberOfLines={1}>
              {item.title}
            </Text>
            <HStack space="xs" className="mt-1 items-center">
              {(() => {
                const meta = rowMeta?.(item);
                if (!meta) {
                  return (
                    <Badge variant="outline" className="border-border">
                      <BadgeText className="text-2xs normal-case">{item.kind}</BadgeText>
                    </Badge>
                  );
                }
                return (
                  <Badge
                    testID={`threadList.status.${item.id}`}
                    variant={meta.danger ? 'destructive' : 'outline'}
                    className={meta.danger ? '' : 'border-border'}
                  >
                    <BadgeText className="text-2xs normal-case">{meta.badge}</BadgeText>
                  </Badge>
                );
              })()}
              {/* Someone else's conversation, shared with this user. The role
                  matters as much as the fact: a viewer's composer is disabled,
                  so saying which they hold explains the difference before they
                  hit it. */}
              {!isOwner(item) && (
                <Badge
                  testID={`threadList.shared.${item.id}`}
                  variant="outline"
                  className="border-primary"
                >
                  <BadgeText className="text-2xs normal-case text-primary">
                    {item.role === 'editor' ? 'shared · can edit' : 'shared · view only'}
                  </BadgeText>
                </Badge>
              )}
              <Text size="2xs" className="text-muted-foreground">
                {rowMeta?.(item)?.time ?? item.time}
              </Text>
            </HStack>
          </Pressable>
        )}
      />

      <Actionsheet isOpen={!!actionsFor} onClose={() => { setActionsFor(null); }}>
        <ActionsheetBackdrop />
        <ActionsheetContent testID="threadList.actions">
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          {actionsFor && (
            <>
              {onFork && (
                <ActionsheetItem
                  onPress={() => {
                    onFork(actionsFor.id);
                    setActionsFor(null);
                  }}
                >
                  <ActionsheetIcon as={GitFork} />
                  <ActionsheetItemText>Fork conversation</ActionsheetItemText>
                </ActionsheetItem>
              )}
              {onShare && isOwner(actionsFor) && (
                <ActionsheetItem
                  testID="threadList.share"
                  onPress={() => {
                    onShare(actionsFor.id);
                    setActionsFor(null);
                  }}
                >
                  <ActionsheetIcon as={Users} />
                  <ActionsheetItemText>Share…</ActionsheetItemText>
                </ActionsheetItem>
              )}
              {/* Rename and Delete are owner actions, like Share. The server
                  refuses both for anyone else, so offering them to a guest
                  only produced a local change that silently reverted on the
                  next load. */}
              {onRename && isOwner(actionsFor) && (
                <ActionsheetItem
                  onPress={() => {
                    setRenameText(actionsFor.title);
                    setRenaming(actionsFor);
                    setActionsFor(null);
                  }}
                >
                  <ActionsheetIcon as={Pencil} />
                  <ActionsheetItemText>Rename</ActionsheetItemText>
                </ActionsheetItem>
              )}
              <ActionsheetItem
                onPress={() => {
                  setActionsFor(null);
                }}
              >
                <ActionsheetIcon as={Download} />
                <ActionsheetItemText>Export as Markdown</ActionsheetItemText>
              </ActionsheetItem>
              {isOwner(actionsFor) && (
                <ActionsheetItem
                  testID="threadList.delete"
                  onPress={() => {
                    // Confirmed by the caller, not here: the sheet and the
                    // header menu open the same dialog, so there is one place
                    // that words what deleting does on this deployment.
                    onDelete(actionsFor.id);
                    setActionsFor(null);
                  }}
                >
                  <ActionsheetIcon as={Trash2} className="text-destructive" />
                  <ActionsheetItemText className="text-destructive">Delete</ActionsheetItemText>
                </ActionsheetItem>
              )}
            </>
          )}
        </ActionsheetContent>
      </Actionsheet>

      <Actionsheet isOpen={!!renaming} onClose={() => { setRenaming(null); }}>
        <ActionsheetBackdrop />
        <ActionsheetContent>
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          <VStack space="sm" className="w-full p-3">
            <HStack className="items-center justify-between">
              <Text className="font-medium text-foreground">Rename conversation</Text>
              <Pressable onPress={() => { setRenaming(null); }}>
                <Icon as={X} size="sm" className="text-muted-foreground" />
              </Pressable>
            </HStack>
            <Input>
              <InputField
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                onSubmitEditing={() => {
                  if (onRename && renaming && renameText.trim()) onRename(renaming.id, renameText.trim());
                  setRenaming(null);
                }}
              />
            </Input>
          </VStack>
        </ActionsheetContent>
      </Actionsheet>
    </VStack>
  );
}
