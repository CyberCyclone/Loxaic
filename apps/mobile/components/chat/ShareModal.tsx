import { useCallback, useEffect, useState } from 'react';
import { Modal, ModalBackdrop, ModalContent, ModalHeader, ModalBody, ModalCloseButton } from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Icon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { X } from 'lucide-react-native';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import {
  deleteShare,
  getShares,
  putShare,
  searchUsers,
  type ConversationShare,
  type DirectoryUser,
} from '@loxaic/api-client';

/**
 * Who a conversation is shared with, and at what level.
 *
 * Owner-only by construction: the server refuses these routes to anyone else,
 * and the entry point that opens this modal is only rendered for an owner.
 * Both checks matter — the UI one is convenience, the server one is the
 * control.
 */
export function ShareModal({
  open,
  onClose,
  conversationId,
  title,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string | null;
  title: string;
}) {
  const [shares, setShares] = useState<ConversationShare[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reachable = useServerReachable();

  useEffect(() => {
    if (!open || !conversationId) return;
    setError(null);
    // Clear before fetching: otherwise the previous conversation's guest list
    // shows under this one's title until the request resolves — with live
    // Revoke buttons that would act on the wrong conversation.
    setShares([]);
    getShares(conversationId).then(setShares, (err: unknown) => {
      setError(describeRequestError(err, 'Something went wrong'));
    });
  }, [open, conversationId]);

  // The directory search is deliberately manual (see the server route): it
  // needs two characters and returns nothing without them, so there is no
  // point firing a request per keystroke.
  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setResults(await searchUsers(q.trim()).catch(() => []));
  }, []);

  const grant = async (userId: string, role: 'viewer' | 'editor') => {
    if (!conversationId) return;
    setBusy(true);
    try {
      setShares(await putShare(conversationId, userId, role));
      setQuery('');
      setResults([]);
    } catch (err) {
      setError(describeRequestError(err, 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (userId: string) => {
    if (!conversationId) return;
    setBusy(true);
    try {
      setShares(await deleteShare(conversationId, userId));
    } catch (err) {
      setError(describeRequestError(err, 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent>
        <ModalHeader>
          <Heading size="md" className="text-foreground">Share “{title}”</Heading>
          <ModalCloseButton testID="share.close">
            <Icon as={X} className="text-muted-foreground" />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody>
          <VStack space="md">
            {error && (
              <Text testID="share.error" size="sm" className="text-destructive">{error}</Text>
            )}
            <DisconnectedNote testID="share.disconnected" what="change who it is shared with" />

            <VStack space="xs">
              <Text size="sm" className="text-muted-foreground">Add someone by name or email</Text>
              <Input className="h-11">
                <InputField
                  testID="share.search"
                  placeholder="Search people…"
                  value={query}
                  onChangeText={(v) => { setQuery(v); void runSearch(v); }}
                  autoCapitalize="none"
                />
              </Input>
            </VStack>

            {results.map((u) => (
              <HStack key={u.id} space="sm" className="items-center justify-between">
                <VStack className="flex-1">
                  <Text size="sm" className="text-foreground">{u.name}</Text>
                  <Text size="xs" className="text-muted-foreground">{u.email}</Text>
                </VStack>
                <Button
                  testID={`share.add.viewer.${u.id}`}
                  size="sm"
                  variant="outline"
                  isDisabled={busy || !reachable}
                  onPress={() => { void grant(u.id, 'viewer'); }}
                >
                  <ButtonText>Can view</ButtonText>
                </Button>
                <Button
                  testID={`share.add.editor.${u.id}`}
                  size="sm"
                  isDisabled={busy || !reachable}
                  onPress={() => { void grant(u.id, 'editor'); }}
                >
                  <ButtonText>Can edit</ButtonText>
                </Button>
              </HStack>
            ))}

            <Box className="h-px bg-border" />

            {shares.length === 0 ? (
              <Text testID="share.empty" size="sm" className="text-muted-foreground">
                Only you can see this conversation.
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
                    testID={`share.role.${s.userId}`}
                    size="sm"
                    variant="outline"
                    isDisabled={busy || !reachable}
                    onPress={() => { void grant(s.userId, s.role === 'editor' ? 'viewer' : 'editor'); }}
                  >
                    <ButtonText>{s.role === 'editor' ? 'Make viewer' : 'Make editor'}</ButtonText>
                  </Button>
                  <Pressable
                    testID={`share.revoke.${s.userId}`}
                    disabled={busy || !reachable}
                    onPress={() => { void revoke(s.userId); }}
                  >
                    <Icon as={X} size="sm" className="text-muted-foreground" />
                  </Pressable>
                </HStack>
              ))
            )}
          </VStack>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
