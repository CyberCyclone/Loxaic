import { useCallback, useEffect, useState } from 'react';
import { FlatList } from 'react-native';
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
import {
  adminGetShares,
  adminListConversations,
  adminPatchShare,
  searchUsers,
  type AdminConversation,
  type ConversationShare,
  type DirectoryUser,
} from '@shannon/api-client';

/**
 * Admin oversight: every conversation on this deployment, and who can reach
 * each one.
 *
 * Deliberately narrow. It lists **metadata** — owner, title, activity, share
 * count — and lets an admin grant or revoke access. It does not read message
 * contents in bulk and cannot send, delete, or transfer ownership. An admin
 * who needs to see a thread opens it the ordinary way (where they resolve to
 * `viewer`); one who needs to participate grants themselves editor here,
 * which is recorded against their name in the share row.
 */
export default function AdminScreen() {
  const { isAdmin } = useSession();
  const shell = useShell();
  const [rows, setRows] = useState<AdminConversation[]>([]);
  const [selected, setSelected] = useState<AdminConversation | null>(null);
  const [shares, setShares] = useState<ConversationShare[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    setShares(await adminGetShares(row.id).catch(() => []));
  }, []);

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
        subtitle={`${String(rows.length)} conversations`}
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
      />
      <HStack className="flex-1">
        <VStack className="flex-1 border-r border-border">
          {error && (
            <Text testID="admin.error" size="sm" className="p-4 text-destructive">{error}</Text>
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
                <Text className="text-foreground" numberOfLines={1}>{item.title}</Text>
                <HStack space="xs" className="items-center">
                  <Text size="xs" className="text-muted-foreground">
                    {item.ownerName} · {item.kind}
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

        <VStack className="flex-1 p-4">
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
                    <Button
                      testID={`admin.share.revoke.${s.userId}`}
                      size="sm"
                      variant="outline"
                      onPress={() => { void patch({ user_id: s.userId, revoke: true }); }}
                    >
                      <ButtonText>Revoke</ButtonText>
                    </Button>
                  </HStack>
                ))
              )}
            </VStack>
          )}
        </VStack>
      </HStack>
    </VStack>
  );
}
