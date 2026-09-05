import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Boxes, ChevronRight, Plug } from 'lucide-react-native';
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
import { useSettings } from '@/hooks/useSettings';
import { useThemePreference, type ThemePreference } from '@/hooks/useTheme';
import { removeItem, setItem } from '@/lib/storage';
import { resolveEndpoint, setEndpoint } from '@/lib/endpoint';
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
  const [draft, setDraft] = useState<Settings>(settings);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setDirty(false);
    }
  }, [open, settings]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const save = () => {
    setSettings(draft);
    const endpoint = draft.endpoint.trim();
    if (endpoint) {
      setItem('shannon-endpoint', endpoint);
      // setEndpoint, not setApiBaseUrl: the api-client's base URL is only half
      // of it. endpoint.ts caches the resolution and the chat/agent sockets
      // hold a URL captured when their effect last ran, so both have to be
      // told or the change appears to work and then silently doesn't.
      setEndpoint(endpoint);
    } else {
      // Clearing the field has to actually clear the override. It previously
      // fell through this branch entirely, so an endpoint could be set from
      // the UI but never unset from it — the only way back was reinstalling.
      removeItem('shannon-endpoint');
      setEndpoint(null);
      // resolveEndpoint assigns the resolved value directly and never fires
      // the listeners the chat/agent sockets subscribe to — only setEndpoint
      // does. Without routing the result back through it, REST moves to the
      // new server while both sockets stay connected to the old one until an
      // app restart: a split-brain where the socket keeps streaming to a host
      // the user thinks they left.
      void resolveEndpoint(true).then((resolved) => {
        if (resolved) setEndpoint(resolved);
      });
    }
    setDirty(false);
    showToast('Settings saved');
  };

  const discard = () => {
    setDraft(settings);
    setDirty(false);
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent>
        <ModalHeader>
          <Heading size="sm">Settings</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Display name
              </Text>
              <Input className="border-border bg-card">
                <InputField value={draft.name} onChangeText={(v) => { update('name', v); }} />
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

            <Pressable
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
                  placeholder="https://your-server.tailnet.ts.net"
                  autoCapitalize="none"
                  value={draft.endpoint}
                  onChangeText={(v) => { update('endpoint', v); }}
                />
              </Input>
              <Text size="2xs" className="text-muted-foreground">
                Overrides auto-detection (LAN then tailnet). Leave blank to auto-detect.
              </Text>
            </VStack>
          </VStack>
        </ModalBody>
        {dirty && (
          <ModalFooter className="justify-between border-t border-border">
            <Text size="xs" className="text-muted-foreground">
              Unsaved changes
            </Text>
            <HStack space="sm">
              <Button variant="outline" size="sm" onPress={discard}>
                <ButtonText>Discard</ButtonText>
              </Button>
              <Button size="sm" className="bg-primary" onPress={save}>
                <ButtonText className="text-primary-foreground">Save changes</ButtonText>
              </Button>
            </HStack>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
