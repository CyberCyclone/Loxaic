import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Check, Server, Laptop, Monitor, FolderGit2, FolderOpen, FolderPlus, ShieldOff, Container, X } from 'lucide-react-native';
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
  getExecutors,
  getGithubBranches,
  getGithubConnection,
  getGithubRepos,
  type ConfigResponse,
  type ExecutorView,
  type GithubRepo,
} from '@loxaic/api-client';
import type { WorkspaceChoice } from '@/lib/types';
import { describeRetention } from '@/lib/retention';
import { useLocalExecutor } from '@/hooks/useLocalExecutor';

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

/** How long to wait for the server to learn about a folder just picked
 * here: the desktop tells the executor, the executor tells the server, and
 * only then will the server accept a workspace in it. */
const ROOT_SYNC_TIMEOUT_MS = 5_000;

/**
 * Where the next agent conversation runs, and what is in it.
 *
 * Two questions, asked in order. *Where* is the machine — this server, or
 * one of the user's own machines with the desktop app open. *Source* is
 * what the working directory starts as — empty, or a clone of one of their
 * GitHub repos — and only applies to the server: a local workspace *is* a
 * folder they already have. The choice is made before the first message
 * and fixed for the life of the conversation, because the agent's system
 * prompt is derived from it.
 *
 * GitHub is refused, with the reason, rather than hidden when it cannot
 * work: a clone needs a network the sandbox does not have unless an admin
 * enabled it, and a coding agent that cannot `npm install` is not one.
 * Local is refused the same way — no desktop app, not signed in there, the
 * executor still connecting — so the fix is always on screen.
 *
 * Folders on this machine come from the OS's own folder dialog and nowhere
 * else: there is no text field for a path anywhere in here, and folders on
 * the user's *other* machines can only be chosen from what those machines
 * announced. A server (or a page) cannot point the desktop at a folder.
 */
export function WorkspaceChooser({ open, onClose, value, onChange, config, token }: WorkspaceChooserProps) {
  const router = useRouter();
  const local = useLocalExecutor();
  const [where, setWhere] = useState<Where>(value.kind === 'local' ? 'local' : 'remote');
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
  const [executors, setExecutors] = useState<ExecutorView[]>([]);
  const [executorId, setExecutorId] = useState<string | null>(value.kind === 'local' ? value.executorId : null);
  const [localPath, setLocalPath] = useState<string | null>(value.kind === 'local' ? value.path : null);
  const [isolation, setIsolation] = useState<'direct' | 'container'>(value.kind === 'local' ? value.isolation : 'direct');
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const allowNetwork = config?.sandbox.allowNetwork ?? false;
  const sandboxAvailable = config?.sandbox.available ?? false;

  const loadExecutors = useCallback(async () => {
    try {
      const list = await getExecutors();
      setExecutors(list);
      return list;
    } catch {
      setExecutors([]);
      return [];
    }
  }, []);

  // Reset to the current value each time it opens, and refresh what it
  // depends on: which host this is, whether GitHub is connected, and which
  // of the user's machines are connected.
  useEffect(() => {
    if (!open || !token) return;
    setSearch('');
    setPickError(null);
    setWhere(value.kind === 'local' ? 'local' : 'remote');
    setSource(value.kind === 'github' ? 'github' : 'scratch');
    void getCluster().then((c) => {
      setHostName(c?.hosts.find((h) => h.self)?.name ?? null);
    });
    void getGithubConnection()
      .then((c) => { setConnected(c !== null); })
      .catch(() => { setConnected(false); });
    void loadExecutors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  // The executor coming online while the dialog is open is exactly the
  // moment the list should refresh — it is what the user is waiting for.
  useEffect(() => {
    if (!open || local.state !== 'online') return;
    void loadExecutors();
  }, [open, local.state, loadExecutors]);

  // Repos load once the GitHub source is chosen and a connection exists.
  useEffect(() => {
    if (!open || where !== 'remote' || source !== 'github' || !connected) return;
    setReposLoading(true);
    getGithubRepos()
      .then(setRepos)
      .catch(() => { setRepos([]); })
      .finally(() => { setReposLoading(false); });
  }, [open, where, source, connected]);

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

  // Default the machine to this one when it is connected, else the first.
  useEffect(() => {
    if (executorId && executors.some((e) => e.id === executorId)) return;
    const mine = executors.find((e) => e.id === local.executorId) ?? executors.at(0);
    setExecutorId(mine?.id ?? null);
    setLocalPath(null);
    // A choice made against one machine must not survive onto another that
    // cannot honour it.
    if (!mine?.capabilities.container) setIsolation('direct');
  }, [executors, executorId, local.executorId]);

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

  // Local is offered whenever *any* of the user's machines is connected —
  // this one, or another one running the desktop app. The reason shown when
  // none is names what to do about it.
  const localBlockedReason =
    executors.length > 0
      ? null
      : !local.available
        ? 'Only from the Loxaic desktop app: open this chat there to work in a folder on that machine.'
        : local.state === 'unavailable'
          ? (local.reason ?? 'The desktop app has no executor built.')
          : local.state === 'unauthorized'
            ? 'This machine could not sign in to the server — sign out and back in.'
            : local.state === 'online'
              ? 'Connecting your machine to the server…'
              : `Your machine is ${local.state === 'connecting' ? 'reconnecting to the server' : local.reason ?? 'not connected'}…`;

  const selectedExecutor = executors.find((e) => e.id === executorId) ?? null;
  const isThisMachine = selectedExecutor !== null && selectedExecutor.id === local.executorId;

  const pickFolder = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const picked = await local.pickDirectory();
      if (!picked) return;
      // The path is only usable once the server has heard about it from the
      // executor; wait for that rather than letting a send fail with "not a
      // folder you have chosen" a moment later.
      const deadline = Date.now() + ROOT_SYNC_TIMEOUT_MS;
      for (;;) {
        const list = await loadExecutors();
        const mine = list.find((e) => e.id === local.executorId);
        if (mine?.roots.includes(picked)) {
          setExecutorId(mine.id);
          setLocalPath(picked);
          return;
        }
        if (Date.now() > deadline) {
          setPickError('The server has not heard about that folder yet — try again in a moment.');
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (err) {
      setPickError(err instanceof Error ? err.message : 'Could not choose a folder');
    } finally {
      setPicking(false);
    }
  };

  const canConfirm =
    where === 'local'
      ? selectedExecutor !== null && localPath !== null
      : source === 'scratch' || (repo !== null && baseBranch !== '' && branchName.trim() !== '');

  const confirm = () => {
    if (where === 'local') {
      if (selectedExecutor && localPath) {
        onChange({ kind: 'local', executorId: selectedExecutor.id, executorName: selectedExecutor.name, path: localPath, isolation });
      }
    } else if (source === 'scratch') {
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
                title="Local — one of your machines"
                detail={localBlockedReason ?? 'Directly in a folder on a machine of yours that has the desktop app open.'}
                selected={where === 'local'}
                disabled={localBlockedReason !== null}
                onPress={() => { setWhere('local'); }}
              />
            </VStack>

            {where === 'local' && (
              <VStack space="sm">
                <Text size="xs" className="text-muted-foreground">
                  Which machine
                </Text>
                <VStack space="xs">
                  {executors.map((e) => (
                    <OptionRow
                      key={e.id}
                      testID={`agent.workspace.executor.${e.id}`}
                      icon={e.id === local.executorId ? Laptop : Monitor}
                      title={e.id === local.executorId ? `${e.name} — this machine` : e.name}
                      detail={e.roots.length === 0 ? 'No folders chosen yet.' : `${String(e.roots.length)} folder${e.roots.length === 1 ? '' : 's'} available`}
                      selected={executorId === e.id}
                      onPress={() => {
                        setExecutorId(e.id);
                        setLocalPath(null);
                      }}
                    />
                  ))}
                </VStack>

                {selectedExecutor && (
                  <VStack space="xs">
                    <Text size="xs" className="text-muted-foreground">
                      Folder
                    </Text>
                    {selectedExecutor.roots.length === 0 && !isThisMachine && (
                      <Text size="xs" className="text-muted-foreground">
                        Folders are chosen on that machine, in its own desktop app.
                      </Text>
                    )}
                    {selectedExecutor.roots.map((root) => (
                      <Pressable
                        key={root}
                        testID={`agent.workspace.root.${encodeURIComponent(root)}`}
                        onPress={() => { setLocalPath(root); }}
                        className={`flex-row items-center justify-between rounded-md border px-3 py-2 ${
                          localPath === root ? 'border-primary bg-primary/10' : 'border-border bg-card'
                        }`}
                      >
                        <Text size="sm" className="flex-1 text-foreground" numberOfLines={1}>
                          {root}
                        </Text>
                        <HStack space="sm" className="items-center">
                          {localPath === root && <Icon as={Check} size="sm" className="text-primary" />}
                          {isThisMachine && (
                            <Pressable
                              testID={`agent.workspace.root.remove.${encodeURIComponent(root)}`}
                              onPress={() => {
                                void local.removeRoot(root).then(() => loadExecutors());
                                if (localPath === root) setLocalPath(null);
                              }}
                              className="rounded-sm p-1 web:hover:bg-muted/50"
                            >
                              <Icon as={X} size="xs" className="text-muted-foreground" />
                            </Pressable>
                          )}
                        </HStack>
                      </Pressable>
                    ))}
                    {isThisMachine && (
                      <Button
                        testID="agent.workspace.pickDirectory"
                        variant="outline"
                        size="sm"
                        isDisabled={picking}
                        onPress={() => { void pickFolder(); }}
                      >
                        <Icon as={FolderPlus} size="sm" className="text-foreground" />
                        <ButtonText>{picking ? 'Choosing…' : 'Choose a folder on this machine…'}</ButtonText>
                      </Button>
                    )}
                    {pickError && (
                      <Text testID="agent.workspace.pickError" size="xs" className="text-destructive">
                        {pickError}
                      </Text>
                    )}
                  </VStack>
                )}

                <VStack space="xs">
                  <Text size="xs" className="text-muted-foreground">
                    Isolation
                  </Text>
                  <OptionRow
                    testID="agent.workspace.isolation.direct"
                    icon={ShieldOff}
                    title="Direct"
                    detail="Commands run as you, in that folder, with no sandbox. Every change is immediate and real."
                    selected={isolation === 'direct'}
                    onPress={() => { setIsolation('direct'); }}
                  />
                  <OptionRow
                    testID="agent.workspace.isolation.container"
                    icon={Container}
                    title="Container"
                    detail={
                      selectedExecutor?.capabilities.container
                        ? 'The folder is mounted into a container on that machine. The agent sees it and nothing else of the filesystem.'
                        : 'Needs Docker or Podman running on that machine.'
                    }
                    selected={isolation === 'container'}
                    disabled={!selectedExecutor?.capabilities.container}
                    onPress={() => { setIsolation('container'); }}
                  />
                </VStack>

                <Text testID="agent.workspace.localWarning" size="xs" className="text-warning">
                  {isolation === 'container'
                    ? 'Anyone you share this chat with as an editor will be running commands on your machine, inside that container.'
                    : 'Anyone you share this chat with as an editor will be running commands on your machine.'}
                </Text>
              </VStack>
            )}

            {where === 'remote' && (
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
            )}

            {where === 'remote' && source === 'github' && connected && (
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

            {where === 'remote' && config && (
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
