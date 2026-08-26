import { useEffect, useState } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Input, InputField } from '@/components/ui/input';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { McpApiError, type McpServer, type McpServerInput } from '@shannon/api-client';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TRANSPORTS = ['stdio', 'http'] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** "KEY=value" lines <-> record. Forgiving on blanks; = required. */
function parseKeyValues(text: string): { record: Record<string, string>; error: string | null } {
  const record: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) return { record, error: `Expected KEY=value, got "${trimmed.slice(0, 40)}"` };
    record[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return { record, error: null };
}

function toKeyValueText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
}

interface McpServerModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: McpServerInput) => Promise<void>;
  editing?: McpServer | null;
}

export function McpServerModal({ open, onClose, onSave, editing }: McpServerModalProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [envText, setEnvText] = useState('');
  const [secretsText, setSecretsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ssrfPrompt, setSsrfPrompt] = useState(false);
  const [saving, setSaving] = useState(false);

  // Built-in servers keep their launch config; only name/env/secrets are editable.
  const builtin = !!editing?.builtinKey;

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setSlug(editing?.slug ?? '');
      setSlugTouched(!!editing);
      setTransport(editing?.transport ?? 'stdio');
      setCommand(editing?.command ?? '');
      setArgsText(Array.isArray(editing?.args) ? (editing.args as string[]).join('\n') : '');
      setUrl(editing?.url ?? '');
      setHeadersText(toKeyValueText(editing?.headers));
      setEnvText(toKeyValueText(editing?.env));
      setSecretsText('');
      setError(null);
      setSsrfPrompt(false);
      setSaving(false);
    }
  }, [open, editing]);

  const updateName = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const buildInput = (allowPrivateNetwork?: boolean): McpServerInput | null => {
    const env = parseKeyValues(envText);
    if (env.error) {
      setError(`Environment: ${env.error}`);
      return null;
    }
    const headers = parseKeyValues(headersText);
    if (headers.error) {
      setError(`Headers: ${headers.error}`);
      return null;
    }
    const secrets = parseKeyValues(secretsText);
    if (secrets.error) {
      setError(`Secrets: ${secrets.error}`);
      return null;
    }

    const input: McpServerInput = { name: name.trim() };
    if (Object.keys(env.record).length || editing) input.env = env.record;
    if (Object.keys(secrets.record).length) input.secrets = secrets.record;
    if (allowPrivateNetwork) input.allowPrivateNetwork = true;

    if (!editing) {
      if (!SLUG_RE.test(slug)) {
        setError('Slug must be 1-32 chars of a-z, 0-9, and dashes');
        return null;
      }
      input.slug = slug;
      input.transport = transport;
    }
    if (!builtin) {
      if (transport === 'stdio') {
        if (!command.trim()) {
          setError('Command is required for stdio servers');
          return null;
        }
        input.command = command.trim();
        input.args = argsText
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean);
      } else {
        if (!url.trim()) {
          setError('URL is required for HTTP servers');
          return null;
        }
        input.url = url.trim();
        if (Object.keys(headers.record).length || editing) input.headers = headers.record;
      }
    }
    return input;
  };

  const handleSave = async (allowPrivateNetwork?: boolean) => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    const input = buildInput(allowPrivateNetwork);
    if (!input) return;
    setSaving(true);
    setError(null);
    setSsrfPrompt(false);
    try {
      await onSave(input);
      onClose();
    } catch (err) {
      if (err instanceof McpApiError && err.ssrf) {
        // The AC's GUI-confirmed override: surface the guard's reason and ask
        // before re-submitting with allowPrivateNetwork.
        setError(err.message);
        setSsrfPrompt(true);
      } else {
        setError(err instanceof McpApiError ? err.message : 'Failed to save MCP server');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">{editing ? `Edit ${editing.name}` : 'Add MCP Server'}</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody>
          <VStack space="lg">
            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name
              </Text>
              <Input className="border-border bg-card">
                <InputField value={name} onChangeText={updateName} placeholder="My MCP server" />
              </Input>
            </VStack>

            {!editing && (
              <VStack space="xs">
                <Text size="xs" className="text-muted-foreground">
                  Slug — prefixes this server's tool names, e.g. {slug || 'slug'}__search
                </Text>
                <Input className="border-border bg-card">
                  <InputField
                    value={slug}
                    onChangeText={(v) => {
                      setSlugTouched(true);
                      setSlug(v);
                    }}
                    placeholder="my-server"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ fontFamily: 'ui-monospace' }}
                  />
                </Input>
              </VStack>
            )}

            {!editing && (
              <VStack space="xs">
                <Text size="xs" className="text-muted-foreground">
                  Transport
                </Text>
                <HStack space="xs">
                  {TRANSPORTS.map((t) => (
                    <Pressable
                      key={t}
                      onPress={() => setTransport(t)}
                      className={`rounded-full px-3 py-1.5 ${transport === t ? 'bg-primary/15' : 'bg-muted'}`}
                    >
                      <Text size="sm" className={transport === t ? 'text-primary' : 'text-muted-foreground'}>
                        {t === 'stdio' ? 'stdio (local process)' : 'HTTP (remote)'}
                      </Text>
                    </Pressable>
                  ))}
                </HStack>
              </VStack>
            )}

            {!builtin && transport === 'stdio' && (
              <>
                <VStack space="xs">
                  <Text size="xs" className="text-muted-foreground">
                    Command
                  </Text>
                  <Input className="border-border bg-card">
                    <InputField
                      value={command}
                      onChangeText={setCommand}
                      placeholder="/usr/local/bin/my-mcp-server"
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ fontFamily: 'ui-monospace' }}
                    />
                  </Input>
                </VStack>
                <VStack space="xs">
                  <Text size="xs" className="text-muted-foreground">
                    Arguments (one per line)
                  </Text>
                  <Textarea size="md" className="border-border bg-card">
                    <TextareaInput
                      value={argsText}
                      onChangeText={setArgsText}
                      placeholder={'--stdio'}
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ height: 56, fontFamily: 'ui-monospace' }}
                    />
                  </Textarea>
                </VStack>
              </>
            )}

            {!builtin && transport === 'http' && (
              <>
                <VStack space="xs">
                  <Text size="xs" className="text-muted-foreground">
                    URL
                  </Text>
                  <Input className="border-border bg-card">
                    <InputField
                      value={url}
                      onChangeText={setUrl}
                      placeholder="https://mcp.example.com/mcp"
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ fontFamily: 'ui-monospace' }}
                    />
                  </Input>
                </VStack>
                <VStack space="xs">
                  <Text size="xs" className="text-muted-foreground">
                    Headers (KEY=value, one per line)
                  </Text>
                  <Textarea size="md" className="border-border bg-card">
                    <TextareaInput
                      value={headersText}
                      onChangeText={setHeadersText}
                      placeholder={'X-Custom-Header=value'}
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ height: 56, fontFamily: 'ui-monospace' }}
                    />
                  </Textarea>
                </VStack>
              </>
            )}

            {(!builtin || transport === 'stdio') && (
              <VStack space="xs">
                <Text size="xs" className="text-muted-foreground">
                  Environment (KEY=value, one per line)
                </Text>
                <Textarea size="md" className="border-border bg-card">
                  <TextareaInput
                    value={envText}
                    onChangeText={setEnvText}
                    placeholder={'MY_SETTING=value'}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ height: 56, fontFamily: 'ui-monospace' }}
                  />
                </Textarea>
              </VStack>
            )}

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Secrets (KEY=value, one per line) — encrypted at rest, never shown again
              </Text>
              {editing && editing.secretKeys.length > 0 && (
                <Text size="xs" className="text-muted-foreground">
                  Stored: {editing.secretKeys.map((k) => `${k} ••••`).join(', ')} — re-enter a key to replace it
                </Text>
              )}
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
                  value={secretsText}
                  onChangeText={setSecretsText}
                  placeholder={'API_KEY=sk-...'}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  style={{ height: 56, fontFamily: 'ui-monospace' }}
                />
              </Textarea>
            </VStack>

            {error && (
              <Text size="xs" className="text-destructive">
                {error}
              </Text>
            )}
            {ssrfPrompt && (
              <VStack space="xs" className="rounded-md border border-warning/30 bg-warning/10 p-2">
                <Text size="xs" className="text-foreground">
                  This URL points at a private or local address. Only allow it if you run the MCP server
                  yourself and trust it.
                </Text>
                <Button size="sm" variant="outline" className="self-start" onPress={() => handleSave(true)}>
                  <ButtonText>Allow private address</ButtonText>
                </Button>
              </VStack>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end border-t border-border">
          <HStack space="sm">
            <Button variant="outline" size="sm" onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button size="sm" className="bg-primary" onPress={() => handleSave()} isDisabled={!name.trim() || saving}>
              {saving && <ButtonSpinner />}
              <ButtonText className="text-primary-foreground">Save server</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
