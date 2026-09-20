import { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { ShieldAlert, Users } from 'lucide-react-native';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { useSession } from '@/lib/session';
import { Badge, BadgeText } from '@/components/ui/badge';
import { AdminTranscript } from '@/components/admin/AdminTranscript';
import { DeletedChatRetention } from '@/components/admin/DeletedChatRetention';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useConversationRetention } from '@/hooks/useConversationRetention';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import {
  adminGetMessages,
  adminGetShares,
  adminListConversations,
  adminPatchShare,
  adminPurgeConversation,
  adminRestoreConversation,
  adminSetConversationHold,
  searchUsers,
  type AdminConversation,
  type AdminMessage,
  type ConversationShare,
  type DirectoryUser,
} from '@loxaic/api-client';

/**
 * Admin oversight: every conversation on this deployment, and who can reach
 * each one.
 *
 * Still narrow: an admin may grant or revoke access and read a transcript, but
 * cannot send or transfer ownership. One who needs to participate grants
 * themselves editor here, which is recorded against their name in the share
 * row.
 *
 * The transcript is read-only and is the reason retention exists — a
 * conversation kept after its owner deleted it is reachable from nowhere
 * else, `resolveAccess` refusing it on every ordinary path including every
 * socket. For a live conversation it shows the same thing an admin could
 * already open as a viewer.
 */
export default function AdminScreen() {
  const { isAdmin, token } = useSession();
  const shell = useShell();
  const [rows, setRows] = useState<AdminConversation[]>([]);
  const [selected, setSelected] = useState<AdminConversation | null>(null);
  const [shares, setShares] = useState<ConversationShare[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [purging, setPurging] = useState<AdminConversation | null>(null);
  const { settings: retention, update: updateRetention } = useConversationRetention(token);

  useEffect(() => {
    if (!isAdmin) return;
    adminListConversations().then(setRows, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [isAdmin]);

  const openDetail = useCallback(async (row: AdminConversation) => {
    setSelected(row);
    setQuery('');
    setResults([]);
    setMessages([]);
    setLoadingTranscript(true);
    // Shares and transcript together: a deleted conversation still has its
    // shares (nothing cascaded — the row survived), and who could reach it is
    // part of what an audit is asking.
    const [nextShares, nextMessages] = await Promise.all([
      adminGetShares(row.id).catch(() => []),
      adminGetMessages(row.id).catch(() => []),
    ]);
    setShares(nextShares);
    setMessages(nextMessages);
    setLoadingTranscript(false);
  }, []);

  /** Re-reads the list and keeps the detail pane pointed at the same row, or
   * closes it when that row is gone (erased). */
  const refreshRows = useCallback(
    async (keepId: string | null) => {
      const next = await adminListConversations().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (!next) return;
      setRows(next);
      setSelected(keepId ? (next.find((r) => r.id === keepId) ?? null) : null);
    },
    [],
  );

  const act = useCallback(
    async (row: AdminConversation, what: 'restore' | 'purge' | 'hold' | 'release') => {
      setError(null);
      try {
        if (what === 'restore') await adminRestoreConversation(row.id);
        else if (what === 'purge') await adminPurgeConversation(row.id);
        else await adminSetConversationHold(row.id, what === 'hold');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      await refreshRows(what === 'purge' ? null : row.id);
    },
    [refreshRows],
  );

  const patch = async (input: { user_id: string; role?: 'viewer' | 'editor'; revoke?: boolean }) => {
    if (!selected) return;
    try {
      setShares(await adminPatchShare(selected.id, input));
      setQuery('');
      setResults([]);
      setRows(await adminListConversations());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Server-enforced too — `requireAdmin` guards every route this screen calls.
  // This is the courtesy version, so a non-admin sees an explanation instead
  // of a screen full of failed requests.
  if (!isAdmin) {
    return (
      <VStack className="h-full flex-1">
        <MainHeader title="Admin" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
        <VStack space="sm" className="flex-1 items-center justify-center px-8">
          <Icon as={ShieldAlert} size="xl" className="text-muted-foreground" />
          <Text testID="admin.denied" className="text-center text-muted-foreground">
            Admin access is required to view all conversations on this server.
          </Text>
        </VStack>
      </VStack>
    );
  }

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Admin"
        subtitle={subtitleFor(rows)}
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
      />
      <HStack className="flex-1">
        <VStack className="flex-1 border-r border-border">
          {error && (
            <Text testID="admin.error" size="sm" className="p-4 text-destructive">{error}</Text>
          )}
          {retention && (
            <DeletedChatRetention settings={retention} onChange={(patch) => { void updateRetention(patch); }} />
          )}
          <FlatList
            testID="admin.conversationList"
            data={rows}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <Pressable
                testID={`admin.conversation.${item.id}`}
                className={`border-b border-border px-4 py-3 ${selected?.id === item.id ? 'bg-muted' : ''}`}
                onPress={() => { void openDetail(item); }}
              >
                <HStack space="xs" className="items-center">
                  <Text className="min-w-0 flex-1 text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                    {item.title}
                  </Text>
                  {item.deletedAt && (
                    <Badge
                      testID={`admin.conversation.deleted.${item.id}`}
                      variant="outline"
                      className="shrink-0 border-destructive"
                    >
                      <BadgeText className="text-2xs normal-case text-destructive">Deleted</BadgeText>
                    </Badge>
                  )}
                </HStack>
                <HStack space="xs" className="items-center">
                  <Text size="xs" className="text-muted-foreground">
                    {item.ownerName} · {item.kind}
                    {item.deletedAt ? ` · ${retentionNote(item)}` : ''}
                  </Text>
                  {item.shareCount > 0 && (
                    <HStack space="xs" className="items-center">
                      <Icon as={Users} size="2xs" className="text-muted-foreground" />
                      <Text size="xs" className="text-muted-foreground">{item.shareCount}</Text>
                    </HStack>
                  )}
                </HStack>
              </Pressable>
            )}
          />
        </VStack>

        {/* A ScrollView, not a Box: gluestack puts `min-h-0` on every
            VStack/Box, which removes the browser's default protection against
            shrinking a flex item below its content — so without one, the
            transcript compresses the sections above it instead of overflowing.
            Same lesson as the agent Inspector. */}
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 16 }}>
          {!selected ? (
            <Text size="sm" className="text-muted-foreground">
              Select a conversation to see who can reach it.
            </Text>
          ) : (
            <VStack space="md">
              <VStack space="xs">
                <Heading size="sm" className="text-foreground">{selected.title}</Heading>
                <Text size="xs" className="text-muted-foreground">
                  Owned by {selected.ownerName} ({selected.ownerEmail})
                </Text>
              </VStack>

              {selected.deletedAt ? (
                // A deleted conversation is not one to change the sharing of
                // — nobody can reach it through a share. What an admin can do
                // is give it back, hold it, or finish the job.
                <VStack space="sm" className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <Text testID="admin.deleted.note" size="xs" className="text-foreground">
                    Deleted by its owner on {new Date(selected.deletedAt).toLocaleString()}.{' '}
                    {retentionNote(selected)}. Its workspace was destroyed at the time and does not
                    come back.
                  </Text>
                  <HStack space="sm">
                    <Button
                      testID="admin.deleted.restore"
                      size="sm"
                      variant="outline"
                      onPress={() => { void act(selected, 'restore'); }}
                    >
                      <ButtonText>Restore to owner</ButtonText>
                    </Button>
                    <Button
                      testID="admin.deleted.hold"
                      size="sm"
                      variant="outline"
                      onPress={() => { void act(selected, selected.deletedHold ? 'release' : 'hold'); }}
                    >
                      <ButtonText>{selected.deletedHold ? 'Release' : 'Hold'}</ButtonText>
                    </Button>
                    <Button
                      testID="admin.deleted.purge"
                      size="sm"
                      className="bg-destructive"
                      onPress={() => { setPurging(selected); }}
                    >
                      <ButtonText className="text-destructive-foreground">Erase now</ButtonText>
                    </Button>
                  </HStack>
                </VStack>
              ) : (
                <>
                  <Input className="h-11">
                    <InputField
                      testID="admin.share.search"
                      placeholder="Grant access to…"
                      value={query}
                      onChangeText={(v) => {
                        setQuery(v);
                        if (v.trim().length >= 2) void searchUsers(v.trim()).then(setResults, () => { setResults([]); });
                        else setResults([]);
                      }}
                      autoCapitalize="none"
                    />
                  </Input>

                  {results.map((u) => (
                    <HStack key={u.id} space="sm" className="items-center justify-between">
                      <Text size="sm" className="flex-1 text-foreground">{u.name}</Text>
                      <Button
                        testID={`admin.share.add.${u.id}`}
                        size="sm"
                        variant="outline"
                        onPress={() => { void patch({ user_id: u.id, role: 'viewer' }); }}
                      >
                        <ButtonText>Can view</ButtonText>
                      </Button>
                    </HStack>
                  ))}
                </>
              )}

              <Box className="h-px bg-border" />

              {shares.length === 0 ? (
                <Text testID="admin.share.empty" size="sm" className="text-muted-foreground">
                  Not shared with anyone.
                </Text>
              ) : (
                shares.map((s) => (
                  <HStack key={s.userId} space="sm" className="items-center justify-between">
                    <VStack className="flex-1">
                      <Text size="sm" className="text-foreground">{s.name}</Text>
                      <Text size="xs" className="text-muted-foreground">
                        {s.email} · {s.role === 'editor' ? 'can edit' : 'can view'}
                      </Text>
                    </VStack>
                    {!selected.deletedAt && (
                      <Button
                        testID={`admin.share.revoke.${s.userId}`}
                        size="sm"
                        variant="outline"
                        onPress={() => { void patch({ user_id: s.userId, revoke: true }); }}
                      >
                        <ButtonText>Revoke</ButtonText>
                      </Button>
                    )}
                  </HStack>
                ))
              )}

              <Box className="h-px bg-border" />

              <Text size="xs" className="text-muted-foreground">
                Transcript
              </Text>
              <AdminTranscript messages={messages} loading={loadingTranscript} />
            </VStack>
          )}
        </ScrollView>
      </HStack>

      <WarningConfirmModal
        open={purging !== null}
        title="Erase this conversation?"
        message={`“${purging?.title ?? ''}” and its messages are erased now, before the end of the retention window. This cannot be undone.`}
        confirmLabel="Erase"
        testIDPrefix="admin.purgeConfirm"
        onCancel={() => { setPurging(null); }}
        onConfirm={() => {
          const row = purging;
          setPurging(null);
          if (row) void act(row, 'purge');
        }}
      />
    </VStack>
  );
}

/** The list now mixes live conversations with retained ones, so the count
 * says how many of each rather than one number meaning two things. */
function subtitleFor(rows: AdminConversation[]): string {
  const deleted = rows.filter((r) => r.deletedAt).length;
  const live = rows.length - deleted;
  return deleted === 0
    ? `${String(live)} conversations`
    : `${String(live)} conversations · ${String(deleted)} deleted`;
}

/** What is scheduled to happen to a retained conversation, in words. */
function retentionNote(row: AdminConversation): string {
  if (row.deletedHold) return 'Held — the sweep will not erase it';
  if (!row.purgeAt) return 'Kept until the retention policy can be read';
  const at = new Date(row.purgeAt);
  return at.getTime() <= Date.now() ? 'Erased at the next sweep' : `Erased ${at.toLocaleDateString()}`;
}
