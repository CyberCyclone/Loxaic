import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField, InputSlot, InputIcon } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge, BadgeText } from '@/components/ui/badge';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import { useSession } from '@/lib/session';

/**
 * Connect a personal access token so agent chats can clone, commit, push and
 * open pull requests against the user's own repos.
 *
 * A PAT rather than OAuth: no GitHub app registration, no callback URL, and
 * it works identically for a self-hosted deployment nobody outside it can
 * reach. The trade — a user has to go create the token themselves — is spelled
 * out in the scope hint below rather than assumed obvious.
 */
export default function GithubScreen() {
  const shell = useShell();
  const { token: sessionToken } = useSession();
  const { connection, loading, error, connect, disconnect } = useGithubConnection(sessionToken);
  const [draft, setDraft] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConnect = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const ok = await connect(draft.trim());
      if (ok) setDraft('');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnect();
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="GitHub" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView className="flex-1">
        <VStack space="lg" className="p-4">
          {loading ? (
            <Box className="items-center justify-center p-6">
              <Spinner />
            </Box>
          ) : connection ? (
            <VStack testID="github.status" space="md" className="rounded-md border border-border bg-card p-4">
              <HStack space="sm" className="items-center justify-between">
                <VStack>
                  <Text className="font-medium text-foreground">Connected as {connection.login}</Text>
                  {connection.name && (
                    <Text size="sm" className="text-muted-foreground">
                      {connection.name}
                    </Text>
                  )}
                </VStack>
                <Badge variant="outline" className="border-success">
                  <BadgeText className="text-success normal-case">Connected</BadgeText>
                </Badge>
              </HStack>
              {connection.scopes && (
                <Text size="xs" className="text-muted-foreground">
                  Scopes: {connection.scopes}
                </Text>
              )}
              <Button
                testID="github.disconnect"
                variant="outline"
                className="border-destructive"
                onPress={() => { void handleDisconnect(); }}
                isDisabled={busy}
              >
                {busy ? <ButtonSpinner /> : <ButtonText className="text-destructive">Disconnect</ButtonText>}
              </Button>
            </VStack>
          ) : (
            <VStack space="md">
              <Text size="sm" className="text-muted-foreground">
                Connect a personal access token so agent chats can work in your own repositories —
                cloning a repo, committing as you go, and opening a pull request when you ask.
              </Text>
              <Text size="xs" className="text-muted-foreground">
                Create one at github.com → Settings → Developer settings → Personal access tokens.
                A classic token needs the <Text size="xs" className="font-medium text-foreground">repo</Text> scope;
                a fine-grained token needs Contents (read/write) and Pull requests (read/write) on the
                repos you want to use.
              </Text>
              <Input className="h-12">
                <InputField
                  testID="github.token"
                  placeholder="Personal access token"
                  value={draft}
                  onChangeText={setDraft}
                  secureTextEntry={!showToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={() => { void handleConnect(); }}
                />
                <InputSlot testID="github.showToken" className="pr-3" onPress={() => { setShowToken((v) => !v); }}>
                  <InputIcon as={showToken ? EyeOff : Eye} className="text-muted-foreground" />
                </InputSlot>
              </Input>
              {error && (
                <Text testID="github.error" size="sm" className="text-destructive">
                  {error}
                </Text>
              )}
              <Button testID="github.connect" onPress={() => { void handleConnect(); }} isDisabled={busy || !draft.trim()}>
                {busy ? <ButtonSpinner /> : <ButtonText>Connect</ButtonText>}
              </Button>
            </VStack>
          )}
        </VStack>
      </ScrollView>
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
