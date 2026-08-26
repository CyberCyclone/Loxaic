import { useEffect, useRef, useState, type ComponentProps, type Ref } from 'react';
import {
  Platform,
  TextInput,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { ArrowUp, Square, ChevronDown, CircleDot, EyeOff } from 'lucide-react-native';
import { BUILT_IN_COMMANDS, commandQuery, parseCommand, findCommand, type SlashCommand } from '@shannon/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonIcon } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Popover, PopoverBackdrop, PopoverContent, PopoverBody } from '@/components/ui/popover';
import { ContextBreakdown } from '@/components/context/ContextBreakdown';
import { CommandPalette } from './CommandPalette';
import type { ContextView } from '@/hooks/useContextUsage';
import { ContextRing } from './ContextRing';

interface ComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  streaming?: boolean;
  modelName: string;
  /** Null until a conversation exists — the indicator hides entirely. */
  context?: ContextView | null;
  onOpenModelModal: () => void;
  /** Incognito: this turn's conversation is never written to Postgres. */
  incognito?: boolean;
  onToggleIncognito?: () => void;
  /** Once a conversation has sent its first message, incognito is fixed server-side. */
  incognitoLocked?: boolean;
  /** Which screen this composer belongs to — filters the slash palette and
   * is implied server-side by which socket a command rides on. */
  surface: 'chat' | 'agent';
  /** Send() routes a recognized "/name ..." here instead of onSend. */
  onRunCommand: (name: string, args: string) => void;
  /** Seeds the input from OUTSIDE this component's subtree — the agent
   * screen's Inspector renders its own copy of the context popup, not
   * nested inside this Composer, so its Compact button can't just call
   * local state. A fresh `token` (not just new text) is what re-triggers
   * the effect below, so pressing Compact twice in a row still re-seeds and
   * re-focuses even though the text would otherwise be unchanged. */
  commandSeed?: { token: number; text: string } | null;
}

export function Composer({
  onSend,
  onStop,
  streaming,
  modelName,
  context,
  onOpenModelModal,
  incognito = false,
  onToggleIncognito,
  incognitoLocked = false,
  surface,
  onRunCommand,
  commandSeed,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [inputHeight, setInputHeight] = useState(20);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const textareaInputRef = useRef<TextInput>(null);

  // What's typed after "/", or null when it isn't shaped like a command at
  // all — see commandQuery: the palette closes the instant a space lands.
  const commandPrefix = commandQuery(text);
  const filteredCommands =
    commandPrefix !== null
      ? BUILT_IN_COMMANDS.filter((c) => c.surfaces.includes(surface) && c.name.startsWith(commandPrefix))
      : [];
  const paletteOpen = !paletteDismissed && filteredCommands.length > 0;

  // Narrowing the query re-opens the palette and resets the highlight —
  // standard command-palette behavior, and what stops a stale index from
  // pointing past the end of a newly-narrowed list.
  useEffect(() => {
    setPaletteDismissed(false);
    setSelectedCmdIndex(0);
  }, [commandPrefix]);

  // The agent Inspector's Compact button lives outside this component, so it
  // can only reach the input through this prop rather than calling
  // insertCommand() directly.
  useEffect(() => {
    if (!commandSeed) return;
    setText(commandSeed.text);
    textareaInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandSeed?.token]);

  const insertCommand = (cmd: SlashCommand) => {
    setText(`/${cmd.name} `);
    textareaInputRef.current?.focus();
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    const parsed = parseCommand(trimmed);
    const cmd = parsed ? findCommand(parsed.name) : undefined;
    if (parsed && cmd && cmd.surfaces.includes(surface)) {
      onRunCommand(cmd.name, parsed.args);
      setText('');
      setInputHeight(20);
      return;
    }
    // Shaped like "/word ..." but not a real command (or not offered on this
    // surface) — sent as ordinary text. People do start messages with a
    // slash, and the palette never claimed this input for them.
    onSend(trimmed);
    setText('');
    setInputHeight(20);
  };

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (Platform.OS !== 'web') return;
    const nativeEvent = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };

    if (paletteOpen) {
      if (nativeEvent.key === 'ArrowDown') {
        e.preventDefault?.();
        setSelectedCmdIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (nativeEvent.key === 'ArrowUp') {
        e.preventDefault?.();
        setSelectedCmdIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (nativeEvent.key === 'Enter' || nativeEvent.key === 'Tab') {
        e.preventDefault?.();
        const cmd = filteredCommands[Math.min(selectedCmdIndex, filteredCommands.length - 1)];
        if (cmd) insertCommand(cmd);
        return;
      }
      if (nativeEvent.key === 'Escape') {
        e.preventDefault?.();
        setPaletteDismissed(true);
        return;
      }
      // Any other key while the palette is open falls through to the
      // textarea's normal typing — deliberately NOT to the send-on-Enter
      // behavior below, since Enter here is claimed above.
      return;
    }

    if (nativeEvent.key === 'Enter' && !nativeEvent.shiftKey) {
      e.preventDefault?.();
      send();
    }
  };

  return (
    <Box className="border-t border-border bg-background p-3">
      <VStack space="sm" className="mx-auto w-full max-w-[820px]">
        <Box className="relative">
          {paletteOpen && (
            <CommandPalette
              commands={filteredCommands}
              selectedIndex={Math.min(selectedCmdIndex, filteredCommands.length - 1)}
              onSelect={insertCommand}
            />
          )}
          <Textarea size="md" className="border-border bg-card">
            <TextareaInput
              // gluestack's forwarded ref type resolves to TextInputProps
              // instead of the TextInput instance it actually is at runtime
              // (confirmed: .focus() works) — cast around the mistyping.
              ref={textareaInputRef as unknown as Ref<ComponentProps<typeof TextareaInput>>}
              placeholder="Message Shannon..."
              value={text}
              onChangeText={setText}
              onKeyPress={onKeyPress}
              onContentSizeChange={(e) =>
                setInputHeight(Math.min(200, Math.max(20, e.nativeEvent.contentSize.height)))
              }
              style={{ height: inputHeight, maxHeight: 200 }}
              multiline
            />
          </Textarea>
        </Box>

        <HStack space="sm" className="items-center">
          {/* Model selector — opens the model modal (search, live list, thinking chips).
              Long backend model ids (e.g. "google/gemma-4-26b-a4b-qat") must not push
              the context ring or send button off screen, so this is the only element
              allowed to shrink, and its name ellipsizes instead. */}
          <Pressable
            onPress={onOpenModelModal}
            className="shrink flex-row items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5"
            style={{ maxWidth: '65%' }}
          >
            <Icon as={CircleDot} size="2xs" className="text-foreground" />
            <Text
              size="xs"
              numberOfLines={1}
              ellipsizeMode="tail"
              isTruncated
              className="shrink font-medium text-foreground"
            >
              {modelName}
            </Text>
            <Icon as={ChevronDown} size="2xs" className="shrink-0 text-muted-foreground" />
          </Pressable>

          {onToggleIncognito && (
            <Pressable
              onPress={incognitoLocked ? undefined : onToggleIncognito}
              className={`flex-row items-center gap-1 rounded-md border px-2 py-1.5 ${
                incognito ? 'border-primary bg-primary/10' : 'border-border bg-muted'
              }`}
              style={incognitoLocked ? { opacity: 0.7 } : undefined}
            >
              <Icon
                as={EyeOff}
                size="2xs"
                className={incognito ? 'text-primary' : 'text-muted-foreground'}
              />
              <Text size="xs" className={incognito ? 'font-medium text-primary' : 'text-muted-foreground'}>
                Incognito
              </Text>
            </Pressable>
          )}

          <Box className="flex-1" />

          {/* Context indicator */}
          {context && (
            <Popover
              placement="top left"
              isOpen={ctxPopoverOpen}
              onOpen={() => setCtxPopoverOpen(true)}
              onClose={() => setCtxPopoverOpen(false)}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  // The ring and its label are only ~16pt tall — far below a
                  // comfortable touch target, and easy to miss entirely.
                  hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }}
                  className="flex-row items-center gap-1 px-1 py-1"
                >
                  <ContextRing percent={context.percent} />
                  <Text
                    size="2xs"
                    className={
                      context.window != null && context.used > context.window
                        ? 'font-medium text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {context.window != null ? `${context.percent}%` : '—'}
                  </Text>
                </Pressable>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="w-72">
                <PopoverBody>
                  <ContextBreakdown
                    context={context}
                    busy={streaming}
                    onCompact={() => {
                      setCtxPopoverOpen(false);
                      const cmd = findCommand('compact');
                      if (cmd) insertCommand(cmd);
                    }}
                  />
                </PopoverBody>
              </PopoverContent>
            </Popover>
          )}

          {streaming ? (
            <Button size="sm" className="rounded-full bg-destructive px-3" onPress={onStop}>
              <ButtonIcon as={Square} className="text-white" />
            </Button>
          ) : (
            <Button
              size="sm"
              className="rounded-full bg-primary px-3"
              onPress={send}
              isDisabled={!text.trim()}
            >
              <ButtonIcon as={ArrowUp} className="text-primary-foreground" />
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
}
