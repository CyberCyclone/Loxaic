import { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { RotateCw, X } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { useSandboxTerminal } from '@/hooks/useSandboxTerminal';
import { stripAnsi, terminalStatusLine } from '@/lib/terminal';

export interface TerminalPanelProps {
  conversationId: string | null;
  token: string | null;
  open: boolean;
  onClose: () => void;
}

/** Roughly a screenful of scrollback for a phone. The web panel keeps far
 * more (xterm's own buffer); this one is re-rendering a single Text node, so
 * the ceiling is much lower and the oldest lines go first. */
const MAX_LINES = 500;

/**
 * The native terminal: a scrolling transcript and a line input.
 *
 * Not an emulator — escape sequences are stripped rather than interpreted
 * (lib/terminal.ts), so a container's coloured prompt reads as plain text and
 * anything that paints a screen (vim, top) will not work. That is the honest
 * shape for a phone, where a full emulator would be unusable with a software
 * keyboard anyway; the web and desktop panel is the real one.
 */
export function TerminalPanel({ conversationId, token, open, onClose }: TerminalPanelProps) {
  const terminal = useSandboxTerminal(conversationId, token, open);
  const [lines, setLines] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView | null>(null);
  const ttyRef = useRef<boolean | null>(null);
  ttyRef.current = terminal.tty;

  useEffect(() => {
    if (!open) return;
    setLines([]);
    return terminal.subscribe((data) => {
      const text = stripAnsi(data);
      if (!text) return;
      setLines((previous) => {
        // Chunks arrive mid-line, so the first piece continues the last line
        // rather than starting a new one.
        const incoming = text.split('\n');
        const merged = previous.length > 0
          ? [...previous.slice(0, -1), (previous[previous.length - 1] ?? '') + incoming[0], ...incoming.slice(1)]
          : incoming;
        return merged.slice(-MAX_LINES);
      });
    });
    // `terminal.subscribe` is stable (useCallback with no deps); the hook's
    // result object is not — it is a fresh reference every render — so
    // listing it made this effect re-run on every render, and its first
    // statement is `setLines([])`: render → effect → set → render, until
    // React threw "Maximum update depth exceeded" and the panel never opened.
    // Only the browser spec exercises a panel, which is why CI never saw it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, terminal.subscribe]);

  if (!open) return null;

  const submit = () => {
    const command = draft;
    setDraft('');
    // A pipe-mode shell echoes nothing, so without this the command the user
    // typed would vanish and only its output would appear. A real TTY echoes
    // it back itself, and echoing here too would show it twice.
    if (ttyRef.current === false) setLines((previous) => [...previous, `$ ${command}`].slice(-MAX_LINES));
    terminal.send(`${command}\n`);
  };

  return (
    <VStack testID="agent.terminal.panel" className="h-64 border-t border-border bg-card">
      <HStack className="items-center justify-between border-b border-border px-3 py-2">
        <Text size="xs" className="font-semibold text-foreground">
          Terminal
        </Text>
        <HStack space="xs" className="items-center">
          <Pressable
            testID="agent.terminal.reconnect"
            onPress={terminal.reconnect}
            className="rounded-sm p-1 web:hover:bg-muted/50"
          >
            <Icon as={RotateCw} size="xs" className="text-muted-foreground" />
          </Pressable>
          <Pressable
            testID="agent.terminal.close"
            onPress={onClose}
            className="rounded-sm p-1 web:hover:bg-muted/50"
          >
            <Icon as={X} size="xs" className="text-muted-foreground" />
          </Pressable>
        </HStack>
      </HStack>

      <Text testID="agent.terminal.status" size="xs" className="px-3 py-1 text-muted-foreground" numberOfLines={2}>
        {terminalStatusLine(terminal.status, terminal.tty, terminal.workdir, terminal.error, terminal.hasSandbox)}
      </Text>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => { scrollRef.current?.scrollToEnd({ animated: false }); }}
      >
        <Text testID="agent.terminal.view" size="xs" className="font-mono text-foreground">
          {lines.join('\n')}
        </Text>
      </ScrollView>

      <Box className="border-t border-border p-2">
        <Input className="border-border bg-background">
          <InputField
            testID="agent.terminal.input"
            placeholder={terminal.status === 'open' ? 'Type a command…' : 'Not connected'}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            editable={terminal.status === 'open'}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
          />
        </Input>
      </Box>
    </VStack>
  );
}
