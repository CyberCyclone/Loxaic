import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Eye, EyeOff } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField, InputSlot, InputIcon } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge, BadgeText } from '@/components/ui/badge';
import { Pressable } from '@/components/ui/pressable';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';

/**
 * Connect a personal access token so agent chats can clone, commit, push and
 * open pull requests against the user's own repos.
 *
 * A PAT rather than OAuth: no GitHub app registration, no callback URL, and
 * it works identically for a self-hosted deployment nobody outside it can
 * reach. The trade — a user has to go create the token themselves — is spelled
 * out in the scope hint below rather than assumed obvious.
 */
/** Same idiom as components/markdown/inlines.tsx: a device with no browser to
 * hand has nothing sensible to do with the rejection. */
function openLink(href: string) {
  void Linking.openURL(href).catch(() => {
    /* no browser to open it with */
  });
}

export default function GithubScreen() {
  const shell = useShell();
  const router = useRouter();
  const { token: sessionToken } = useSession();
  const { connection, loading, unknown, error, connect, disconnect } = useGithubConnection(sessionToken);
  const reachable = useServerReachable();
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
          ) : unknown ? (
            <Text testID="github.unknown" size="sm" className="text-muted-foreground">
              Can&apos;t check your GitHub connection while your server is unreachable. It will load once the server is back.
            </Text>
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
              {/* Three states, not two. Conflating them is how this screen
                  named the wrong fix in both directions.

                  `null` is a fine-grained token: GitHub sends no scopes header
                  at all, so "unknown" is the only honest answer, and the fix
                  lives in that token's repository permissions.

                  `""` is a *classic* token reporting positively that it holds
                  no scopes. That is not unknown, it is "no access", and the fix
                  is the repo scope — nothing about Contents applies to it. A
                  truthiness test put this case in the fine-grained branch and
                  told the user to grant a permission their token type does not
                  have.

                  A non-empty string is just the scope list. Rendering nothing
                  at all, which this once did, was the original bug. */}
              {connection.scopes == null ? (
                <Text testID="github.status.permissions" size="xs" className="text-muted-foreground">
                  Fine-grained token. GitHub does not report what these can reach, so Loxaic cannot
                  show it here. Connecting proved the token is yours, not that it can reach your
                  code: it needs Contents (read and write) on each repository you work in, and Pull
                  requests (read and write) to open a PR.
                </Text>
              ) : connection.scopes === '' ? (
                <Text testID="github.status.permissions" size="xs" className="text-muted-foreground">
                  Classic token with no scopes. GitHub reports this one as having no access at all,
                  so nothing will work until you add the{' '}
                  <Text size="xs" className="font-medium text-foreground">repo</Text> scope to it.
                  Contents and Pull requests are fine-grained settings and do not apply to a classic
                  token.
                </Text>
              ) : (
                <Text size="xs" className="text-muted-foreground">
                  Scopes: {connection.scopes}
                </Text>
              )}
              {/* The MCP tools are set up by connecting, so this card is where
                  someone learns they exist — and, when they could not be set
                  up, the only place that says why. */}
              {connection.mcp?.ok ? (
                <VStack space="xs" className="rounded-md border border-border bg-background p-3">
                  <Text testID="github.mcp.status" size="xs" className="text-foreground">
                    {connection.mcp.enabled
                      ? 'GitHub tools are on for chats and agents. Reading issues, pull requests and files runs without asking; anything that changes GitHub asks first.'
                      : 'GitHub tools are set up but switched off. Switch them on under MCP Servers.'}
                  </Text>
                  <Pressable testID="github.mcp.manage" onPress={() => { router.push('/mcp'); }}>
                    <Text size="xs" className="text-primary">
                      Manage GitHub tools →
                    </Text>
                  </Pressable>
                </VStack>
              ) : (
                <Text testID="github.mcp.error" size="xs" className="text-warning">
                  {/* An older server sends no `mcp` at all, and so no reason
                      either — absence reads as "not set up here", never as a
                      blank screen. */}
                  {connection.mcp?.error ?? 'GitHub tools are not available on this server.'}
                </Text>
              )}
              <Button
                testID="github.disconnect"
                variant="outline"
                className="border-destructive"
                onPress={() => { void handleDisconnect(); }}
                isDisabled={busy || !reachable}
              >
                {busy ? <ButtonSpinner /> : <ButtonText className="text-destructive">Disconnect</ButtonText>}
              </Button>
              {/* Shown here too: it used to be rendered only with the setup form,
                  so a failed disconnect said nothing at all. */}
              {error && (
                <Text testID="github.error" size="sm" className="text-destructive">
                  {error}
                </Text>
              )}
            </VStack>
          ) : (
            <VStack space="md">
              {/* Spelled out at length, deliberately. The old two-line hint
                  named the right permissions and still left someone stuck: it
                  said nothing about which repositories a fine-grained token can
                  see, nothing about the resource owner, and nothing about the
                  fact that connecting succeeds for a token that can reach no
                  code at all. A hidden instruction was the whole failure. */}
              <VStack testID="github.setup" space="md">
                <Text size="sm" className="text-muted-foreground">
                  Connect a personal access token so agent chats can work in your own repositories —
                  cloning a repo, committing as you go, and opening a pull request when you ask.
                </Text>

                <Text size="xs" className="text-muted-foreground">
                  The same token also turns on GitHub tools for chats: reading and searching issues,
                  pull requests and code through GitHub’s own MCP server. Nothing else to set up. For
                  those, a fine-grained token also needs{' '}
                  <Text size="xs" className="font-medium text-foreground">Issues: Read</Text> on
                  the repositories you want the model to read.
                </Text>

                <Text size="xs" className="text-muted-foreground">
                  Both kinds of GitHub token work. Pick either.
                </Text>

                <VStack space="xs">
                  <Text size="xs" className="font-medium text-foreground">
                    Fine-grained token (the modern one)
                  </Text>
                  <Pressable
                    testID="github.help.createToken"
                    onPress={() => { openLink('https://github.com/settings/personal-access-tokens/new'); }}
                  >
                    <Text size="xs" className="text-primary">
                      Create one on GitHub →
                    </Text>
                  </Pressable>
                  <Text size="xs" className="text-muted-foreground">
                    Repository access: “All repositories”, or “Only select repositories” with every
                    repo you want to work in listed. A repo that is not on that list is invisible to
                    the token.
                  </Text>
                  <Text size="xs" className="text-muted-foreground">
                    Resource owner: yourself, for your own repos. For an organisation’s repo choose
                    the organisation — it has to allow fine-grained tokens, and an admin may have to
                    approve yours before it starts working.
                  </Text>
                  <Text size="xs" className="text-muted-foreground">
                    Permissions, under Repository:{' '}
                    <Text size="xs" className="font-medium text-foreground">Contents: Read and write</Text>{' '}
                    (clone the repo, push your branch) and{' '}
                    <Text size="xs" className="font-medium text-foreground">Pull requests: Read and write</Text>{' '}
                    (open a PR from here). Metadata: Read is added for you as soon as you pick either
                    of those.
                  </Text>
                </VStack>

                <VStack space="xs">
                  <Text size="xs" className="font-medium text-foreground">
                    Classic token (the legacy one)
                  </Text>
                  <Pressable
                    testID="github.help.createClassic"
                    onPress={() => { openLink('https://github.com/settings/tokens'); }}
                  >
                    <Text size="xs" className="text-primary">
                      Create one on GitHub →
                    </Text>
                  </Pressable>
                  <Text size="xs" className="text-muted-foreground">
                    One scope: <Text size="xs" className="font-medium text-foreground">repo</Text>.
                  </Text>
                </VStack>

                <Text size="xs" className="text-muted-foreground">
                  Connecting only proves the token is yours. GitHub answers “who am I” for a token
                  with no permissions at all, and a repo can appear in the picker on Metadata alone —
                  so if Contents is missing, the clone is where it shows up. GitHub’s message for
                  that one says “Write access to repository not granted” even when what it wants is
                  read.
                </Text>

                <Text size="xs" className="text-muted-foreground">
                  Give it an expiry you are happy with. When it lapses, cloning and pushing stop
                  until you connect a new one.
                </Text>
              </VStack>
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
              <Button testID="github.connect" onPress={() => { void handleConnect(); }} isDisabled={busy || !draft.trim() || !reachable}>
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
