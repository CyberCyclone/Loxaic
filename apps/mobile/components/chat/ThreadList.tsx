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
import type { RowRunBadge } from '@/lib/runWatch';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';

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
   * How a row reads, where its own title does not distinguish it.
   *
   * A routine's chats are all named after the routine, which is also this
   * panel's own heading — so every row read identically and there was nothing
   * to pick between them. `title` replaces the row's title (the run's time)
   * and `badge` replaces the kind badge (its status).
   */
  rowMeta?: (c: Conversation) => { title?: string; badge: string | null; danger?: boolean; time: string } | null;
  /**
   * Which rows have a run going, and what it is doing (#282).
   *
   * A dot and a word (Running, Queued · #2, Awaiting approval…) beside the
   * row, from the run registry through the socket's liveness watch — so a
   * row says "Running" for a routine that fired, another device's send, or a
   * run this device started and switched away from. While a row has one it
   * takes the kind badge's slot: the panel is 280px wide, already carries a
   * share badge, and "chat" says less than "Running" does. `rowMeta`'s own
   * badge (a routine run's recorded status) yields to it while the run is
   * going and returns when it ends.
   */
  runStatus?: Partial<Record<string, RowRunBadge>>;
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
  runStatus,
}: ThreadListProps) {
  const [search, setSearch] = useState('');
  const [actionsFor, setActionsFor] = useState<Conversation | null>(null);
  // Share and Delete are requests; Fork and Rename only change this device.
  const reachable = useServerReachable();
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
        // A thread answers the first tap while the keyboard is up — after a
        // search, or with the composer focused behind the list on a phone.
        // Without this the first tap only closed the keyboard.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
        renderItem={({ item }) => {
          // Read once: a row's badge, if it has one.
          const run = runStatus?.[item.id];
          return (
          <Pressable
            testID={`threadList.item.${item.id}`}
            onPress={() => { onSelect(item.id); }}
            onLongPress={() => { setActionsFor(item); }}
            className={`mb-1 rounded-md p-2.5 ${
              activeId === item.id ? 'bg-muted' : 'web:hover:bg-muted/40'
            }`}
          >
            <Text size="sm" className="font-medium text-foreground" numberOfLines={1}>
              {rowMeta?.(item)?.title ?? item.title}
            </Text>
            <HStack space="xs" className="mt-1 items-center">
              {run && (
                <HStack
                  // The state is part of the id, so a spec can wait for the
                  // exact state on the exact row on every platform — a text
                  // probe would match the open run's own header on native,
                  // where a container's text is not searchable.
                  testID={`threadList.run.${item.id}.${run.state}`}
                  space="xs"
                  accessibilityLabel={`Run status: ${run.label}`}
                  className="items-center rounded-full bg-muted px-1.5 py-0.5"
                >
                  <Box className={`h-1.5 w-1.5 rounded-full ${run.dot}`} />
                  <Text size="2xs" className="text-muted-foreground">
                    {run.label}
                  </Text>
                </HStack>
              )}
              {(() => {
                const meta = rowMeta?.(item);
                if (!meta) {
                  // No run-state badge of its own: the kind badge stands,
                  // unless the live run badge above already replaced it.
                  if (run) return null;
                  return (
                    <Badge variant="outline" className="border-border">
                      <BadgeText className="text-2xs normal-case">{item.kind}</BadgeText>
                    </Badge>
                  );
                }
                // A routine row: its recorded run status yields to the live
                // one while the run is going (they can disagree — the record
                // only refreshes on a list fetch). A null badge is a status
                // the screen knows to be out of date: nothing is better.
                if (run || meta.badge === null) return null;
                return (
                  <Badge
                    testID={`threadList.status.${item.id}`}
                    variant={meta.danger ? 'destructive' : 'outline'}
                    className={meta.danger ? '' : 'border-border'}
                  >
                    {/* Its own testID: on native a container's text cannot
                        be read, and what the status *says* is the point. */}
                    <BadgeText testID={`threadList.status.${item.id}.label`} className="text-2xs normal-case">
                      {meta.badge}
                    </BadgeText>
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
          );
        }}
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
                  isDisabled={!reachable}
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
                  isDisabled={!reachable}
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
              <DisconnectedNote testID="threadList.disconnected" what="share or delete it" className="px-3 pb-2" />
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
