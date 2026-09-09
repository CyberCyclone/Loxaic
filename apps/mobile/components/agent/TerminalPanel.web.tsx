import { useEffect, useRef, useState } from 'react';
import { RotateCw, X } from 'lucide-react-native';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { useSandboxTerminal } from '@/hooks/useSandboxTerminal';
import { terminalStatusLine } from '@/lib/terminal';
import type { TerminalPanelProps } from './TerminalPanel';

/**
 * The real terminal, for web and Electron: xterm.js over `/ws/sandbox/:id`.
 *
 * Two input paths, deliberately. Clicking into the terminal types into it
 * directly — which is the only way `vim`, `Ctrl-C` or an arrow key can work,
 * and needs a real PTY (a container sandbox). The line input below it always
 * works, including on a touch screen and for a pipe-mode session where there
 * is no PTY to type at; it is also what the e2e suite drives, since a hidden
 * textarea inside a canvas-less emulator is not something to select on.
 *
 * xterm's default renderer is the DOM one (canvas and WebGL are separate
 * addons we deliberately do not load), so the text on screen is real DOM
 * text: readable by a screen reader, selectable, and assertable by a test.
 */
export function TerminalPanel({ conversationId, token, open, onClose }: TerminalPanelProps) {
  const terminal = useSandboxTerminal(conversationId, token, open);
  const [draft, setDraft] = useState('');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read inside xterm's own callbacks, which are registered once: the mode
  // is not known until `terminal.ready` arrives, and recreating the emulator
  // then would throw away whatever it had already printed.
  const ttyRef = useRef<boolean | null>(null);
  ttyRef.current = terminal.tty;
  const sendRef = useRef(terminal.send);
  sendRef.current = terminal.send;
  const resizeRef = useRef(terminal.resize);
  resizeRef.current = terminal.resize;

  useEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;

    const term = new Terminal({
      // A pipe-mode shell emits bare "\n"; without this every line after the
      // first would start where the previous one ended.
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: { background: '#0a0a0a', foreground: '#e4e4e7', cursor: '#e4e4e7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // A line editor, but only where the far side has no PTY to run one: with
    // a real terminal the shell echoes and edits for itself, and doing it
    // here as well would double every keystroke.
    let pending = '';
    const onData = term.onData((data) => {
      if (ttyRef.current !== false) {
        sendRef.current(data);
        return;
      }
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          term.write('\r\n');
          sendRef.current(`${pending}\n`);
          pending = '';
        } else if (ch === '\u007f' || ch === '\b') {
          if (pending.length > 0) {
            pending = pending.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch >= ' ') {
          pending += ch;
          term.write(ch);
        }
      }
    });

    const applyFit = () => {
      try {
        fit.fit();
      } catch {
        // A panel mid-animation can measure as zero; the next tick fits.
        return;
      }
      resizeRef.current(term.cols, term.rows);
    };
    applyFit();
    const observer = new ResizeObserver(applyFit);
    observer.observe(host);

    const unsubscribe = terminal.subscribe((chunk) => { term.write(chunk); });

    return () => {
      unsubscribe();
      observer.disconnect();
      onData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // `terminal.subscribe` is stable (useCallback with no deps); listing the
    // whole hook result would tear the emulator down on every status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, terminal.subscribe]);

  // Resize once the size is known: the socket is not open when the emulator
  // mounts, so the fit above had nowhere to send its answer.
  useEffect(() => {
    const term = termRef.current;
    if (terminal.status === 'open' && term) terminal.resize(term.cols, term.rows);
    // `terminal.resize` is a stable useCallback; the hook result is a fresh
    // object every render, and depending on it re-sent a resize per render —
    // one Docker exec/resize API call per keystroke in the input below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.status, terminal.resize]);

  if (!open) return null;

  const submit = () => {
    const command = draft;
    setDraft('');
    // Same reasoning as the native panel: a pipe-mode shell echoes nothing,
    // a PTY echoes it itself.
    if (terminal.tty === false) termRef.current?.write(`$ ${command}\r\n`);
    terminal.send(`${command}\n`);
    termRef.current?.focus();
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

      {/* The emulator's own element, not a gluestack Box: xterm measures and
          positions inside whatever it is given, and needs a plain block with
          a real size. */}
      <div
        data-testid="agent.terminal.view"
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, padding: 8, backgroundColor: '#0a0a0a', overflow: 'hidden' }}
      />

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
