import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Check, Server, Laptop, FolderGit2, FolderOpen } from 'lucide-react-native';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import {
  getCluster,
  getGithubBranches,
  getGithubConnection,
  getGithubRepos,
  type ConfigResponse,
  type GithubRepo,
} from '@loxaic/api-client';
import type { WorkspaceChoice } from '@/lib/types';
import { describeRetention } from '@/lib/retention';

interface WorkspaceChooserProps {
  open: boolean;
  onClose: () => void;
  value: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
  /** From /v1/config — decides whether GitHub is offered at all. */
  config: ConfigResponse | null;
  /** The signed-in token, gating the authenticated fetches. */
  token: string | null;
}

type Where = 'remote' | 'local';
type Source = 'scratch' | 'github';

/**
 * Where the next agent conversation runs, and what is in it.
 *
 * Two questions, asked in order. *Where* is the machine — this server, or (a
 * later stage) the user's own desktop. *Source* is what the working directory
 * starts as — empty, or a clone of one of their GitHub repos. The choice is
 * made before the first message and fixed for the life of the conversation,
 * because the agent's system prompt is derived from it.
 *
 * GitHub is refused, with the reason, rather than hidden when it cannot work:
 * a clone needs a network the sandbox does not have unless an admin enabled
 * it, and a coding agent that cannot `npm install` is not one. Saying so here
 * beats a clone failure on the first tool call.
 */
export function WorkspaceChooser({ open, onClose, value, onChange, config, token }: WorkspaceChooserProps) {
  const router = useRouter();
  const [where, setWhere] = useState<Where>('remote');
  const [source, setSource] = useState<Source>(value.kind === 'github' ? 'github' : 'scratch');
  const [hostName, setHostName] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [branchName, setBranchName] = useState<string>('');

  const allowNetwork = config?.sandbox.allowNetwork ?? false;
  const sandboxAvailable = config?.sandbox.available ?? false;

  // Reset to the current value each time it opens, and refresh what it
  // depends on: which host this is, and whether GitHub is connected.
  useEffect(() => {
    if (!open || !token) return;
    setSearch('');
    setSource(value.kind === 'github' ? 'github' : 'scratch');
    void getCluster().then((c) => {
      setHostName(c?.hosts.find((h) => h.self)?.name ?? null);
    });
    void getGithubConnection()
      .then((c) => { setConnected(c !== null); })
      .catch(() => { setConnected(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  // Repos load once the GitHub source is chosen and a connection exists.
  useEffect(() => {
    if (!open || source !== 'github' || !connected) return;
    setReposLoading(true);
    getGithubRepos()
      .then(setRepos)
      .catch(() => { setRepos([]); })
      .finally(() => { setReposLoading(false); });
  }, [open, source, connected]);

  // Branches follow the chosen repo; the base defaults to the repo's default.
  useEffect(() => {
    if (!repo) {
      setBranches([]);
      return;
    }
    const [owner, name] = repo.full_name.split('/');
    setBaseBranch(repo.default_branch);
    setBranchName(`loxaic/${Math.random().toString(16).slice(2, 10)}`);
    getGithubBranches(owner, name)
      .then((b) => { setBranches(b.branches); })
      .catch(() => { setBranches([repo.default_branch]); });
  }, [repo]);

  const filtered = useMemo(
    () => repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase())),
    [repos, search],
  );

  const githubBlockedReason = !sandboxAvailable
    ? 'Sandboxes are unavailable on this server, so nothing can be cloned.'
    : !allowNetwork
      ? 'Cloning needs network access, which sandboxes on this server do not have. An admin can enable it under Settings → Agent Sandbox.'
      : connected === false
        ? 'GitHub is not connected.'
        : null;

  const canConfirm = source === 'scratch' || (repo !== null && baseBranch !== '' && branchName.trim() !== '');

  const confirm = () => {
    if (source === 'scratch') {
      onChange({ kind: 'scratch' });
    } else if (repo) {
      onChange({ kind: 'github', repo: repo.full_name, baseBranch, branch: branchName.trim() });
    }
    onClose();
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="agent.workspace.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Where should this run?</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Machine
              </Text>
              <OptionRow
                testID="agent.workspace.remote"
                icon={Server}
                title={hostName ? `Remote — ${hostName}` : 'Remote — this server'}
                detail="In a sandbox on the server you are connected to."
                selected={where === 'remote'}
                onPress={() => { setWhere('remote'); }}
              />
              <OptionRow
                testID="agent.workspace.local"
                icon={Laptop}
                title="Local — this machine"
                detail="Coming soon: run directly on your own computer, in a folder you choose."
                selected={where === 'local'}
                disabled
                onPress={() => undefined}
              />
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Start from
              </Text>
              <OptionRow
                testID="agent.workspace.source.scratch"
                icon={FolderOpen}
                title="Empty workspace"
                detail="A fresh directory. Good for experiments and new projects."
                selected={source === 'scratch'}
                onPress={() => { setSource('scratch'); }}
              />
              <OptionRow
                testID="agent.workspace.source.github"
                icon={FolderGit2}
                title="A GitHub repository"
                detail={githubBlockedReason ?? 'Cloned onto a new branch. Commit as you go; push and open a PR from the Inspector.'}
                selected={source === 'github'}
                disabled={githubBlockedReason !== null}
                onPress={() => { setSource('github'); }}
              />
              {githubBlockedReason !== null && connected === false && sandboxAvailable && allowNetwork && (
                <Pressable
                  testID="agent.workspace.connectGithub"
                  onPress={() => {
                    onClose();
                    router.push('/github');
                  }}
                >
                  <Text size="xs" className="text-primary">
                    Connect GitHub in Settings →
                  </Text>
                </Pressable>
              )}
            </VStack>

            {source === 'github' && connected && (
              <VStack space="sm">
                <Text size="xs" className="text-muted-foreground">
                  Repository
                </Text>
                <Input className="border-border bg-card">
                  <InputField
                    testID="agent.workspace.repoSearch"
                    placeholder="Search your repositories…"
                    value={search}
                    onChangeText={setSearch}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Input>
                {reposLoading ? (
                  <Box className="items-center py-4">
                    <Spinner />
                  </Box>
                ) : filtered.length === 0 ? (
                  <Text size="xs" className="text-muted-foreground">
                    {repos.length === 0 ? 'No repositories found for this token.' : 'No matches.'}
                  </Text>
                ) : (
                  <VStack space="xs">
                    {filtered.slice(0, 30).map((r) => (
                      <Pressable
                        key={r.id}
                        testID={`agent.workspace.repo.${String(r.id)}`}
                        onPress={() => { setRepo(r); }}
                        className={`flex-row items-center justify-between rounded-md border px-3 py-2 ${
                          repo?.id === r.id ? 'border-primary bg-primary/10' : 'border-border bg-card'
                        }`}
                      >
                        <VStack>
                          <Text size="sm" className="text-foreground">
                            {r.full_name}
                          </Text>
                          <Text size="xs" className="text-muted-foreground">
                            {r.private ? 'private' : 'public'} · default {r.default_branch}
                          </Text>
                        </VStack>
                        {repo?.id === r.id && <Icon as={Check} size="sm" className="text-primary" />}
                      </Pressable>
                    ))}
                  </VStack>
                )}

                {repo && (
                  <VStack space="sm">
                    <Text size="xs" className="text-muted-foreground">
                      Start from branch
                    </Text>
                    <HStack space="xs" className="flex-wrap">
                      {branches.map((b) => (
                        <Pressable
                          key={b}
                          testID={`agent.workspace.base.${b}`}
                          onPress={() => { setBaseBranch(b); }}
                          className={`rounded-full px-3 py-1 ${baseBranch === b ? 'bg-primary/15' : 'bg-muted'}`}
                        >
                          <Text size="xs" className={baseBranch === b ? 'text-primary' : 'text-muted-foreground'}>
                            {b}
                          </Text>
                        </Pressable>
                      ))}
                    </HStack>
                    <Text size="xs" className="text-muted-foreground">
                      Work on a new branch named
                    </Text>
                    <Input className="border-border bg-card">
                      <InputField
                        testID="agent.workspace.branchName"
                        value={branchName}
                        onChangeText={setBranchName}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </Input>
                  </VStack>
                )}
              </VStack>
            )}

            {config && (
              <Text testID="agent.workspace.retention" size="xs" className="text-muted-foreground">
                {describeRetention(config.sandbox.retention)}
              </Text>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="border-t border-border">
          <Button testID="agent.workspace.confirm" onPress={confirm} isDisabled={!canConfirm}>
            <ButtonText>Use this workspace</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function OptionRow({
  testID,
  icon,
  title,
  detail,
  selected,
  disabled,
  onPress,
}: {
  testID: string;
  icon: typeof Server;
  title: string;
  detail: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      className={`flex-row items-center justify-between rounded-md border px-3 py-2.5 ${
        selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <HStack space="sm" className="flex-1 items-center">
        <Icon as={icon} size="sm" className={selected ? 'text-primary' : 'text-muted-foreground'} />
        <VStack className="flex-1">
          <Text size="sm" className="text-foreground">
            {title}
          </Text>
          <Text size="xs" className="text-muted-foreground">
            {detail}
          </Text>
        </VStack>
      </HStack>
      {selected && !disabled && <Icon as={Check} size="sm" className="text-primary" />}
    </Pressable>
  );
}
