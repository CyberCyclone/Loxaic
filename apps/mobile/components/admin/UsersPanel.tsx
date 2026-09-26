import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { adminListUsers, adminResetUserPassword, type AdminUser } from '@loxaic/api-client';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { Badge, BadgeText } from '@/components/ui/badge';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useToastHelper } from '@/hooks/useToastHelper';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { TRUNCATE_TEXT } from '@/lib/truncate';

/**
 * Accounts on this server, and resetting a forgotten password — the only way
 * one is reset short of the server-side command, since there is no email.
 *
 * The temporary password is shown once, here, and nowhere else: the server
 * returns it in the reset response and stores only its hash. It is the
 * admin's to pass on.
 *
 * No reset button on your own row: it would sign out the very session this
 * screen runs in. Account is the place to change your own password, and the
 * server-side command is the way back in for an admin who cannot sign in.
 */
const SEARCH_DEBOUNCE_MS = 250;

export function UsersPanel({ currentUserId }: { currentUserId: string | null }) {
  const { showToast } = useToastHelper();
  const reachable = useServerReachable();
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AdminUser | null>(null);
  const [result, setResult] = useState<{ email: string; temporaryPassword: string } | null>(null);
  // Typing is debounced — each search is two scans of the user table on the
  // server — and only the newest answer may land, or a slow early one
  // overwrites the list for what was typed after it.
  const requestSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string) => {
    const seq = ++requestSeq.current;
    try {
      const page = await adminListUsers(q.trim() || undefined);
      if (seq !== requestSeq.current) return;
      setUsers(page.users);
      setTotal(page.total);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(describeRequestError(err, 'Something went wrong'));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load('');
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [load]);

  const search = (q: string) => {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { void load(q); }, SEARCH_DEBOUNCE_MS);
  };

  const reset = async (target: AdminUser) => {
    setError(null);
    setResult(null);
    try {
      const { temporaryPassword } = await adminResetUserPassword(target.id);
      setResult({ email: target.email, temporaryPassword });
      await load(query);
    } catch (err) {
      setError(describeRequestError(err, 'Something went wrong'));
    }
  };

  return (
    <VStack className="min-h-0 flex-1">
      <VStack space="sm" className="border-b border-border p-4">
        {result && (
          <VStack
            testID="admin.resetPassword.result"
            space="sm"
            className="rounded-md border border-warning/50 bg-warning/5 p-3"
          >
            <Text size="sm" className="text-foreground">
              Temporary password for {result.email}
            </Text>
            <Text testID="admin.resetPassword.value" selectable className="font-mono text-lg text-foreground">
              {result.temporaryPassword}
            </Text>
            <Text size="xs" className="text-muted-foreground">
              Pass it on to them. They sign in with it once and choose a new password before they can do anything
              else. It is not shown again.
            </Text>
            <HStack space="sm">
              <Button
                testID="admin.resetPassword.copy"
                size="sm"
                variant="outline"
                onPress={() => {
                  void Clipboard.setStringAsync(result.temporaryPassword).then(
                    () => { showToast('Copied'); },
                    () => { showToast('Could not copy — select the text instead'); },
                  );
                }}
              >
                <ButtonText>Copy</ButtonText>
              </Button>
              <Button testID="admin.resetPassword.dismiss" size="sm" variant="outline" onPress={() => { setResult(null); }}>
                <ButtonText>Done</ButtonText>
              </Button>
            </HStack>
          </VStack>
        )}

        <Input className="h-11">
          <InputField
            testID="admin.users.search"
            placeholder="Search by email or name"
            value={query}
            onChangeText={search}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Input>
        {loaded && (
          <Text testID="admin.users.count" size="xs" className="text-muted-foreground">
            {total > users.length
              ? `Showing the newest ${String(users.length)} of ${String(total)} — search to find someone else`
              : `${String(total)} ${total === 1 ? 'account' : 'accounts'}`}
          </Text>
        )}
        {error && (
          <Text testID="admin.users.error" size="sm" className="text-destructive">
            {error}
          </Text>
        )}
      </VStack>

      <FlatList
        testID="admin.userList"
        data={users}
        keyExtractor={(u) => u.id}
        style={{ flex: 1, minHeight: 0 }}
        renderItem={({ item }) => (
          <HStack testID={`admin.user.${item.id}`} space="sm" className="items-center border-b border-border px-4 py-3">
            <VStack className="min-w-0 flex-1">
              <HStack space="xs" className="min-w-0 items-center">
                <Text className="min-w-0 shrink text-foreground" style={TRUNCATE_TEXT}>
                  {item.name}
                </Text>
                {item.role === 'admin' && (
                  <Badge testID={`admin.user.${item.id}.role`} variant="outline" className="shrink-0">
                    <BadgeText className="text-2xs normal-case">Admin</BadgeText>
                  </Badge>
                )}
                {item.mustChangePassword && (
                  <Badge testID={`admin.user.${item.id}.mustChange`} variant="outline" className="shrink-0 border-warning">
                    <BadgeText className="text-2xs normal-case text-warning">Must change password</BadgeText>
                  </Badge>
                )}
                {item.banned && (
                  <Badge variant="outline" className="shrink-0 border-destructive">
                    <BadgeText className="text-2xs normal-case text-destructive">Suspended</BadgeText>
                  </Badge>
                )}
              </HStack>
              <Text size="xs" className="min-w-0 text-muted-foreground" style={TRUNCATE_TEXT}>
                {item.email}
              </Text>
            </VStack>
            {item.id === currentUserId ? (
              <Text size="xs" className="shrink-0 text-muted-foreground">
                You
              </Text>
            ) : (
              <Button
                testID={`admin.user.${item.id}.resetPassword`}
                isDisabled={!reachable}
                size="sm"
                variant="outline"
                className="shrink-0"
                onPress={() => { setConfirming(item); }}
              >
                <ButtonText>Reset password</ButtonText>
              </Button>
            )}
          </HStack>
        )}
      />

      <WarningConfirmModal
        open={confirming !== null}
        title="Reset this password?"
        message={`${confirming?.email ?? ''} is signed out of every device, and their password is replaced with a temporary one shown to you once. They must choose a new password when they next sign in.`}
        confirmLabel="Reset"
        testIDPrefix="admin.resetPasswordConfirm"
        onCancel={() => { setConfirming(null); }}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target) void reset(target);
        }}
      />
    </VStack>
  );
}
