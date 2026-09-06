import { useEffect, useRef, useState, type ComponentProps, type Ref } from 'react';
import { Platform, TextInput, type TextInputKeyPressEvent } from 'react-native';
import { ArrowUp, Square, ChevronDown, CircleDot } from 'lucide-react-native';
import { BUILT_IN_COMMANDS, commandQuery, parseCommand, findCommand, type SlashCommand, type AttachmentRef } from '@loxaic/api-client';
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
import { AttachmentPreview } from './AttachmentPreview';
import { AttachButton } from './AttachButton';
import { AttachmentRejectedModal } from './AttachmentRejectedModal';
import type { ContextView } from '@/hooks/useContextUsage';
import { useComposerAttachments } from '@/hooks/useComposerAttachments';
import { ContextRing } from './ContextRing';

interface ComposerProps {
  onSend: (text: string, attachments?: AttachmentRef[]) => void;
  onStop?: () => void;
  streaming?: boolean;
  modelName: string;
  /** Null until a conversation exists — the indicator hides entirely. */
  context?: ContextView | null;
  onOpenModelModal: () => void;
  /** Which screen this composer belongs to — filters the slash palette and
   * is implied server-side by which socket a command rides on. */
  surface: 'chat' | 'agent';
  /** Set when the conversation can be read but not written to — offline, or
   * shared read-only. The composer becomes an explanation rather than an
   * input: a disabled textarea with no hint of why reads as a bug, and every
   * send would be dropped or rejected server-side anyway. */
  readOnlyReason?: string | null;
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
  surface,
  readOnlyReason = null,
  onRunCommand,
  commandSeed,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [inputHeight, setInputHeight] = useState(20);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const textareaInputRef = useRef<TextInput>(null);
  const {
    items: attachments,
    pickFromLibrary,
    takePhoto,
    pickDocument,
    addWebFiles,
    remove: removeAttachment,
    reset: resetAttachments,
    readyAttachments,
    uploading: attachmentsUploading,
    rejection: attachmentRejection,
    dismissRejection,
  } = useComposerAttachments();

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
    if ((!trimmed && readyAttachments.length === 0) || streaming || attachmentsUploading) return;
    const parsed = parseCommand(trimmed);
    const cmd = parsed ? findCommand(parsed.name) : undefined;
    if (parsed && cmd?.surfaces.includes(surface)) {
      onRunCommand(cmd.name, parsed.args);
      setText('');
      setInputHeight(20);
      return;
    }
    // Shaped like "/word ..." but not a real command (or not offered on this
    // surface) — sent as ordinary text. People do start messages with a
    // slash, and the palette never claimed this input for them.
    onSend(trimmed, readyAttachments.length > 0 ? readyAttachments : undefined);
    setText('');
    setInputHeight(20);
    resetAttachments();
  };

  const onKeyPress = (e: TextInputKeyPressEvent) => {
    if (Platform.OS !== 'web') return;
    const nativeEvent = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };

    if (paletteOpen) {
      if (nativeEvent.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCmdIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (nativeEvent.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCmdIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (nativeEvent.key === 'Enter' || nativeEvent.key === 'Tab') {
        e.preventDefault();
        // Guarded by `paletteOpen` above, which already requires
        // `filteredCommands.length > 0` — so this index is always in range.
        const cmd = filteredCommands[Math.min(selectedCmdIndex, filteredCommands.length - 1)];
        insertCommand(cmd);
        return;
      }
      if (nativeEvent.key === 'Escape') {
        e.preventDefault();
        setPaletteDismissed(true);
        return;
      }
      // Any other key while the palette is open falls through to the
      // textarea's normal typing — deliberately NOT to the send-on-Enter
      // behavior below, since Enter here is claimed above.
      return;
    }

    if (nativeEvent.key === 'Enter' && !nativeEvent.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Box className="border-t border-border bg-background p-3">
      <VStack space="sm" className="mx-auto w-full max-w-[820px]">
        {readOnlyReason ? (
          <Box
            testID="composer.readOnly"
            className="rounded-md border border-border bg-muted px-3 py-3"
          >
            <Text size="sm" className="text-muted-foreground">
              {readOnlyReason}
            </Text>
          </Box>
        ) : (
          <>
        <AttachmentPreview items={attachments} onRemove={removeAttachment} />
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
              testID="composer.input"
              // gluestack's forwarded ref type resolves to TextInputProps
              // instead of the TextInput instance it actually is at runtime
              // (confirmed: .focus() works) — cast around the mistyping.
              ref={textareaInputRef as unknown as Ref<ComponentProps<typeof TextareaInput>>}
              placeholder="Message Loxaic..."
              value={text}
              onChangeText={setText}
              onKeyPress={onKeyPress}
              onContentSizeChange={(e) => { setInputHeight(Math.min(200, Math.max(20, e.nativeEvent.contentSize.height))); }
              }
              style={{ height: inputHeight, maxHeight: 200 }}
              multiline
            />
          </Textarea>
        </Box>

        <HStack space="sm" className="items-center">
          {/* Attach: camera/library actionsheet on native, a real file
              input on web (AttachButton.web.tsx) — see its own comment for
              why the web path isn't expo-image-picker's shim. */}
          <AttachButton
            onTakePhoto={() => { void takePhoto(); }}
            onPickFromLibrary={() => { void pickFromLibrary(); }}
            onPickDocument={() => { void pickDocument(); }}
            onFilesSelected={addWebFiles}
          />
          <AttachmentRejectedModal rejection={attachmentRejection} onClose={dismissRejection} />

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

          <Box className="flex-1" />

          {/* Context indicator */}
          {context && (
            <Popover
              placement="top left"
              isOpen={ctxPopoverOpen}
              onOpen={() => { setCtxPopoverOpen(true); }}
              onClose={() => { setCtxPopoverOpen(false); }}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  testID="composer.context"
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
                    {context.window != null ? `${String(context.percent)}%` : '—'}
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
            <Button
              testID="composer.stop"
              size="sm"
              className="rounded-full bg-destructive px-3"
              onPress={onStop}
            >
              <ButtonIcon as={Square} className="text-white" />
            </Button>
          ) : (
            <Button
              testID="composer.send"
              size="sm"
              className="rounded-full bg-primary px-3"
              onPress={send}
              isDisabled={(!text.trim() && readyAttachments.length === 0) || attachmentsUploading}
            >
              <ButtonIcon as={ArrowUp} className="text-primary-foreground" />
            </Button>
          )}
        </HStack>
          </>
        )}
      </VStack>
    </Box>
  );
}
