import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Boxes, ChevronRight, GitBranch, Plug, Server } from 'lucide-react-native';
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
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { AutoCompactToggle } from './AutoCompactToggle';
import { AgentStepLimit } from './AgentStepLimit';
import { ServerSection } from './ServerSection';
import { UpdatesRow } from './UpdatesRow';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { useSettings } from '@/hooks/useSettings';
import { useThemePreference, type ThemePreference } from '@/hooks/useTheme';
import { removeItem, setItem } from '@/lib/storage';
import { clearCacheForEndpoint } from '@/lib/message-cache';
import { clearToken, loadToken } from '@/lib/auth';
import { useSession } from '@/lib/session';
import { normalizeUrl } from '@/lib/server-address';
import { setAuthToken } from '@loxaic/api-client';
import { currentEndpoint, electronBridge, resolveEndpoint, setEndpoint } from '@/lib/endpoint';
import { useToastHelper } from '@/hooks/useToastHelper';
import type { AgentMode, Settings, ThinkingLevel } from '@/lib/types';

const MODES: AgentMode[] = ['planning', 'manual', 'auto'];
const THINKING: ThinkingLevel[] = ['None', 'Low', 'Medium', 'High'];
const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useSettings();
  const [themePref, setThemePref] = useThemePreference();
  const router = useRouter();
  const { showToast } = useToastHelper();
  const { signOut, isAdmin } = useSession();
  const [draft, setDraft] = useState<Settings>(settings);
  const [dirty, setDirty] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [endpointTest, setEndpointTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingEndpoint, setTestingEndpoint] = useState(false);
  const [confirmEndpoint, setConfirmEndpoint] = useState(false);
  const [endpointError, setEndpointError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setDirty(false);
      setConfirmEndpoint(false);
    }
  }, [open, settings]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  /**
   * Saving, once the endpoint change has been agreed to.
   *
   * Split from `save` so the confirm step cannot be bypassed by a second
   * caller: everything that actually writes goes through here.
   */
  const commit = (moved: boolean) => {
    setSettings(draft);
    const endpoint = draft.endpoint.trim();
    // The old host's session must not follow the endpoint to the new one.
    // BASE_URL moving is only half of a move: the api-client also holds the
    // live bearer in memory, and REST, both stream sockets and every
    // fileUrl() image src would have presented host A's token to host B —
    // which could replay it against A for the life of the session row.
    // Per-endpoint scoping only governs what is *read from storage*, so it
    // has to be dropped here, before the URL moves, and the new endpoint's
    // own token loaded after. detach() does the same for the same reason.
    if (moved) setAuthToken(null);
    if (endpoint) {
      setItem('loxaic-endpoint', endpoint);
      // setEndpoint, not setApiBaseUrl: the api-client's base URL is only half
      // of it. endpoint.ts caches the resolution and the chat/agent sockets
      // hold a URL captured when their effect last ran, so both have to be
      // told or the change appears to work and then silently doesn't.
      setEndpoint(endpoint);
      if (moved) void adoptSessionAt();
    } else {
      // Clearing the field has to actually clear the override. It previously
      // fell through this branch entirely, so an endpoint could be set from
      // the UI but never unset from it — the only way back was reinstalling.
      removeItem('loxaic-endpoint');
      setEndpoint(null);
      // resolveEndpoint assigns the resolved value directly and never fires
      // the listeners the chat/agent sockets subscribe to — only setEndpoint
      // does. Without routing the result back through it, REST moves to the
      // new server while both sockets stay connected to the old one until an
      // app restart: a split-brain where the socket keeps streaming to a host
      // the user thinks they left.
      void resolveEndpoint(true).then(async (resolved) => {
        if (resolved) setEndpoint(resolved);
        if (moved) await adoptSessionAt();
      });
    }
    setDirty(false);
    showToast('Settings saved');
  };

  /** Loads whatever session the endpoint now in effect has — and signs out,
   * honestly, when it has none, rather than leaving the shell up on a token
   * the new server has never seen. */
  const adoptSessionAt = async () => {
    const token = await loadToken();
    if (!token) await signOut();
  };

  /**
   * Changing the endpoint is the one setting here that can cut this device off
   * from the server entirely — an address that is merely mistyped, or a domain
   * whose DNS has not propagated, looks identical to a server that is down.
   * Nothing else on this screen can do that, so nothing else is confirmed.
   *
   * Every other setting rides along with it: refusing to save the rest would
   * mean an admin correcting a display name and a hostname in one visit gets
   * neither until they agree to the risky half separately.
   */
  const save = () => {
    if (draft.endpoint.trim() === settings.endpoint.trim()) {
      commit(false);
      return;
    }
    // Validated *before* the dialog, so it only ever quotes an address that
    // could work. A scheme-less "typo.example.com" — the easiest thing to
    // type when moving a deployment onto a domain — used to commit, then
    // resolve relative on web while the WebSocket constructor threw: a
    // half-connected device with no indication why, right after a dialog
    // had named the address and said the change took effect.
    const next = normalizeUrl(draft.endpoint);
    if (next instanceof Error) {
      setEndpointError(next.message);
      return;
    }
    setEndpointError(null);
    if (next !== null && next !== draft.endpoint) setDraft((d) => ({ ...d, endpoint: next }));
    setConfirmEndpoint(true);
  };

  /**
   * Leave the current host.
   *
   * Order matters: the cache and token are cleared *before* the main process
   * tears the stack down, because both are keyed by the endpoint and reading
   * it back afterwards would give the next one's. Only this endpoint's data
   * goes — another host the user has joined keeps its own session and cache.
   */
  const detach = async () => {
    const endpoint = currentEndpoint();
    if (endpoint) {
      clearCacheForEndpoint(endpoint);
      await clearToken(endpoint);
    }
    removeItem('loxaic-endpoint');
    setConfirmDetach(false);
    onClose();
    await electronBridge()?.instance.detach();
  };

  const discard = () => {
    setDraft(settings);
    setDirty(false);
  };

  /** Same 1500ms /health probe endpoint.ts uses for its own candidates —
   * this is only ever a manual sanity check, so a stale (pre-Save) address
   * is fine to test: whatever's currently typed is what the user wants to
   * know is reachable. */
  const testEndpoint = async () => {
    const url = draft.endpoint.trim();
    if (!url) return;
    setTestingEndpoint(true);
    setEndpointTest(null);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 1500);
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: controller.signal });
      setEndpointTest(res.ok ? { ok: true, message: 'Reachable' } : { ok: false, message: `Server answered ${String(res.status)}` });
    } catch (err) {
      setEndpointTest({
        ok: false,
        message: err instanceof Error && err.name === 'AbortError' ? 'Timed out' : 'Not reachable',
      });
    } finally {
      clearTimeout(timer);
      setTestingEndpoint(false);
    }
  };

  return (
    <>
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      {/* Bounded height, matching McpServerModal.tsx: this modal has grown a
          settings row at a time (theme, thinking level, step limit,
          auto-compact, MCP, sandbox, GitHub) and unlike a short dialog it
          routinely overflows the viewport. Without a cap here the overflow
          just extends past the window edge with nothing to scroll — reachable
          with a trackpad by luck, unreachable to a click (real or
          WebDriver's) on whatever row that pushes below the fold. */}
      <ModalContent className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Settings</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Display name
              </Text>
              <Input className="border-border bg-card">
                <InputField testID="settings.name" value={draft.name} onChangeText={(v) => { update('name', v); }} />
              </Input>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Default mode
              </Text>
              <HStack space="xs">
                {MODES.map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => { update('defaultMode', m); }}
                    className={`rounded-full px-3 py-1.5 ${
                      draft.defaultMode === m ? 'bg-primary/15' : 'bg-muted'
                    }`}
                  >
                    <Text size="sm" className={draft.defaultMode === m ? 'text-primary' : 'text-muted-foreground'}>
                      {m}
                    </Text>
                  </Pressable>
                ))}
              </HStack>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Default thinking level
              </Text>
              <HStack space="xs">
                {THINKING.map((level) => (
                  <Pressable
                    key={level}
                    onPress={() => { update('defaultThinkingLevel', level); }}
                    className={`rounded-full px-3 py-1.5 ${
                      draft.defaultThinkingLevel === level ? 'bg-primary/15' : 'bg-muted'
                    }`}
                  >
                    <Text
                      size="sm"
                      className={draft.defaultThinkingLevel === level ? 'text-primary' : 'text-muted-foreground'}
                    >
                      {level}
                    </Text>
                  </Pressable>
                ))}
              </HStack>
            </VStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Appearance
              </Text>
              <HStack space="xs">
                {THEMES.map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => { setThemePref(t); }}
                    className={`rounded-full px-3 py-1.5 ${themePref === t ? 'bg-primary/15' : 'bg-muted'}`}
                  >
                    <Text size="sm" className={themePref === t ? 'text-primary' : 'text-muted-foreground'}>
                      {t}
                    </Text>
                  </Pressable>
                ))}
              </HStack>
            </VStack>

            <Box className="h-px bg-border" />

            <AgentStepLimit />

            <Box className="h-px bg-border" />

            <AutoCompactToggle />

            <Box className="h-px bg-border" />

            <UpdatesRow />

            <Pressable
              testID="settings.nav.mcp"
              onPress={() => {
                onClose();
                router.push('/mcp');
              }}
              className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/30"
            >
              <HStack space="sm" className="items-center">
                <Icon as={Plug} size="sm" className="text-muted-foreground" />
                <VStack>
                  <Text size="sm" className="text-foreground">
                    MCP Servers
                  </Text>
                  <Text size="2xs" className="text-muted-foreground">
                    Connect external tools for the agent
                  </Text>
                </VStack>
              </HStack>
              <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
            </Pressable>

            <Pressable
              testID="settings.nav.github"
              onPress={() => {
                onClose();
                router.push('/github');
              }}
              className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/30"
            >
              <HStack space="sm" className="items-center">
                <Icon as={GitBranch} size="sm" className="text-muted-foreground" />
                <VStack>
                  <Text size="sm" className="text-foreground">
                    GitHub
                  </Text>
                  <Text size="2xs" className="text-muted-foreground">
                    Connect a repo for the agent to work in
                  </Text>
                </VStack>
              </HStack>
              <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
            </Pressable>

            {/* Admin-only, and only here: unlike the sandbox row — which
                everyone can open to read what the deployment allows — there
                is nothing on the providers screen for a non-admin to do, and
                its list is the deployment's own topology and credentials.
                The route still refuses them; this only stops offering it. */}
            {isAdmin && (
              <Pressable
                testID="settings.nav.providers"
                onPress={() => {
                  onClose();
                  router.push('/providers');
                }}
                className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/30"
              >
                <HStack space="sm" className="items-center">
                  <Icon as={Server} size="sm" className="text-muted-foreground" />
                  <VStack>
                    <Text size="sm" className="text-foreground">
                      Model Providers
                    </Text>
                    <Text size="2xs" className="text-muted-foreground">
                      OpenRouter, OpenAI, Anthropic, or another local server
                    </Text>
                  </VStack>
                </HStack>
                <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
              </Pressable>
            )}

            <Pressable
              testID="settings.nav.sandbox"
              onPress={() => {
                onClose();
                router.push('/sandbox');
              }}
              className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/30"
            >
              <HStack space="sm" className="items-center">
                <Icon as={Boxes} size="sm" className="text-muted-foreground" />
                <VStack>
                  <Text size="sm" className="text-foreground">
                    Agent Sandbox
                  </Text>
                  <Text size="2xs" className="text-muted-foreground">
                    Where the agent runs tool calls
                  </Text>
                </VStack>
              </HStack>
              <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
            </Pressable>

            <Box className="h-px bg-border" />

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Server endpoint
              </Text>
              <Input className="border-border bg-card">
                <InputField
                  testID="settings.endpoint"
                  placeholder="https://your-server.tailnet.ts.net"
                  autoCapitalize="none"
                  value={draft.endpoint}
                  onChangeText={(v) => {
                    update('endpoint', v);
                    setEndpointTest(null);
                    setEndpointError(null);
                  }}
                />
              </Input>
              <HStack space="sm" className="items-center">
                <Button
                  testID="settings.endpoint.test"
                  variant="outline"
                  size="sm"
                  isDisabled={!draft.endpoint.trim() || testingEndpoint}
                  onPress={() => { void testEndpoint(); }}
                >
                  {testingEndpoint ? <ButtonSpinner /> : <ButtonText>Test</ButtonText>}
                </Button>
                {endpointTest && (
                  <Text
                    testID="settings.endpoint.result"
                    size="2xs"
                    className={endpointTest.ok ? 'text-success' : 'text-destructive'}
                  >
                    {endpointTest.message}
                  </Text>
                )}
              </HStack>
              {endpointError && (
                <Text testID="settings.endpoint.error" size="2xs" className="text-destructive">
                  {endpointError}
                </Text>
              )}
              <Text size="2xs" className="text-muted-foreground">
                Overrides auto-detection (LAN then tailnet). Leave blank to auto-detect. For a
                Tailscale host, install the Tailscale app on this device and enter the host&apos;s
                https://….ts.net address — or its Funnel address, if it published one, which needs
                no Tailscale app here.
              </Text>
            </VStack>

            <Box className="h-px bg-border" />

            <ServerSection />

            {/* Desktop only: leaving a host is a main-process action (it stops
                the stack and returns to onboarding), which no other platform
                can do. */}
            {electronBridge() && (
              <VStack space="xs">
                <Text size="xs" className="text-muted-foreground">Disconnect</Text>
                <Button
                  testID="settings.detach"
                  variant="outline"
                  onPress={() => { setConfirmDetach(true); }}
                >
                  <ButtonText className="text-destructive">Disconnect from this server</ButtonText>
                </Button>
                <Text size="2xs" className="text-muted-foreground">
                  Your conversations stay on the server. The copy saved on this device is
                  removed, and you&apos;ll be asked how to set this machine up again.
                </Text>
              </VStack>
            )}
          </VStack>
        </ModalBody>
        {dirty && (
          <ModalFooter className="justify-between border-t border-border">
            <Text size="xs" className="text-muted-foreground">
              Unsaved changes
            </Text>
            <HStack space="sm">
              <Button testID="settings.discard" variant="outline" size="sm" onPress={discard}>
                <ButtonText>Discard</ButtonText>
              </Button>
              <Button testID="settings.save" size="sm" className="bg-primary" onPress={save}>
                <ButtonText className="text-primary-foreground">Save changes</ButtonText>
              </Button>
            </HStack>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
    <WarningConfirmModal
      open={confirmEndpoint}
      title="Change the server address?"
      message={endpointWarning(currentEndpoint() ?? settings.endpoint, draft.endpoint)}
      confirmLabel="Change it"
      testIDPrefix="settings.endpoint.confirm"
      onConfirm={() => { setConfirmEndpoint(false); commit(true); }}
      onCancel={() => { setConfirmEndpoint(false); }}
    />
    <WarningConfirmModal
      open={confirmDetach}
      title="Disconnect from this server?"
      message="Your conversations stay on the server — nothing there is deleted. The copy saved on this device is removed, along with your sign-in for it, and this machine will ask how you want to set it up again."
      confirmLabel="Disconnect"
      testIDPrefix="settings.detach"
      onConfirm={() => { void detach(); }}
      onCancel={() => { setConfirmDetach(false); }}
    />
    </>
  );
}

/**
 * What changing the endpoint will do, in the terms the person changing it is
 * actually working in.
 *
 * Deliberately names both addresses rather than saying "the server address":
 * the case this exists for is an admin moving a deployment from a bare IP to a
 * domain, and a transposed digit or a DNS record that has not propagated yet
 * is indistinguishable from a server that is down. Saying which way it is
 * moving is what makes a typo visible before it is committed.
 *
 * It also says how to get back, because the honest answer is reassuring: the
 * app keeps working from cache while signed in, so this screen stays reachable
 * and the change is reversible right here. The point of no return is signing
 * out, not saving.
 */
function endpointWarning(current: string, next: string): string {
  // `current` is the address actually in effect (currentEndpoint()), not the
  // stored override: on every auto-detected install the override is '' while
  // a real resolved address is in use, and the before/after comparison — the
  // whole point of naming both — vanished on exactly those installs.
  const from = current.trim();
  const to = next.trim();
  if (!to) {
    return (
      `This app will stop using ${from || 'the address you set'} and go back to finding a ` +
      'server automatically. If it finds none, you will not be able to reach your server ' +
      'from this device. You can set an address again on this screen while you are still ' +
      'signed in.'
    );
  }
  return (
    `Everything in this app will talk to ${to}${from ? ` instead of ${from}` : ''}. ` +
    'If that address is wrong, or is not reachable from this device yet, you will lose access ' +
    'to your server — including the ability to sign in again once you sign out. ' +
    'While you stay signed in you can change it back on this screen.'
  );
}
