import { useState } from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';
import { Brain, Camera, Check, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Layers, Plug, Plus } from 'lucide-react-native';
import type { ModelThinking, ThinkingLevel } from '@loxaic/types';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
  ActionsheetItem,
  ActionsheetItemText,
  ActionsheetIcon,
} from '@/components/ui/actionsheet';
import { VStack } from '@/components/ui/vstack';
import type { McpSwitches } from '@/hooks/useMcpSwitches';
import { McpServerList } from './McpServerList';
import { plusMenuPage, type PlusMenuPage } from '@/lib/plusMenuPage';
import { levelChangeRereads, NO_THINKING_REASON, selectedThinkingOption, thinkingOptions } from '@/lib/thinking';

/** Long enough for the sheet's exit animation to finish before another modal
 * is presented (the plan sheet and the no-room modal found the same). */
const SHEET_EXIT_MS = 300;

/** The thinking level, for the selected model. */
export interface ComposerThinking {
  /** What the model takes; null for a model that takes no level, whose row is
   * shown disabled with the reason rather than hidden. */
  capability: ModelThinking | null;
  /** This conversation's level (or the one chosen before it exists). */
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}

export interface ComposerPlusMenuProps {
  /** Native only: opens the camera. */
  onTakePhoto: () => void;
  /** Native only: opens the OS photo library picker. */
  onPickFromLibrary: () => void;
  /** Native only: opens the OS document picker. */
  onPickDocument: () => void;
  /** Web only (see ComposerPlusMenu.web.tsx): files chosen from the file input. */
  onFilesSelected: (files: File[]) => void;
  /** This conversation's MCP switches; null hides the MCP item. */
  mcp: McpSwitches | null;
  /** Context settings, when the selected model has YaRN stages; null leaves
   * the row out. `disabledReason` says why it cannot be used, when it cannot. */
  contextSettings?: { onOpen: () => void; disabledReason: string | null } | null;
  /** The thinking level; null leaves the row out (a routine's chat, whose
   * runs the server starts). */
  thinking?: ComposerThinking | null;
  /** An attachment is uploaded as soon as it is picked, and the MCP switches
   * are saved on the server, so there is nothing to do while it is
   * unreachable. */
  disabled?: boolean;
}

/**
 * The composer's `+`, native: one sheet holding the attach actions and, below
 * them, MCP. Choosing MCP swaps the sheet's content for the server list
 * rather than opening a second sheet — iOS will not present a modal while
 * another is being dismissed (see the plan review's model picker in
 * AGENTS.md). Web renders ComposerPlusMenu.web.tsx instead, which drives a
 * real `<input type="file">` directly — expo-image-picker's web shim creates a
 * transient hidden input at click time with nothing stable to select.
 */
export function ComposerPlusMenu({
  onTakePhoto,
  onPickFromLibrary,
  onPickDocument,
  mcp,
  contextSettings = null,
  thinking = null,
  disabled = false,
}: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PlusMenuPage>('main');
  const shown = plusMenuPage(page, { thinking: Boolean(thinking?.capability), mcp: mcp !== null });
  const { height } = useWindowDimensions();

  const close = () => {
    setOpen(false);
  };

  return (
    <>
      <Pressable
        testID="composer.attach"
        onPress={() => {
          setPage('main');
          setOpen(true);
          mcp?.refresh();
        }}
        disabled={disabled}
        className={`shrink-0 rounded-md border border-border bg-muted p-1.5 ${disabled ? 'opacity-50' : ''}`}
      >
        <Icon as={Plus} size="2xs" className="text-foreground" />
      </Pressable>
      <Actionsheet isOpen={open} onClose={close}>
        <ActionsheetBackdrop />
        <ActionsheetContent>
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          {shown === 'thinking' && thinking?.capability ? (
            <ThinkingPage
              thinking={thinking}
              capability={thinking.capability}
              onBack={() => {
                setPage('main');
              }}
              onChose={close}
            />
          ) : shown === 'main' || !mcp ? (
            <>
              <ActionsheetItem
                testID="composer.attach.camera"
                onPress={() => {
                  close();
                  onTakePhoto();
                }}
              >
                <ActionsheetIcon as={Camera} />
                <ActionsheetItemText>Take photo</ActionsheetItemText>
              </ActionsheetItem>
              <ActionsheetItem
                testID="composer.attach.library"
                onPress={() => {
                  close();
                  onPickFromLibrary();
                }}
              >
                <ActionsheetIcon as={ImageIcon} />
                <ActionsheetItemText>Photo library</ActionsheetItemText>
              </ActionsheetItem>
              <ActionsheetItem
                testID="composer.attach.file"
                onPress={() => {
                  close();
                  onPickDocument();
                }}
              >
                <ActionsheetIcon as={FileText} />
                <ActionsheetItemText>Files</ActionsheetItemText>
              </ActionsheetItem>
              {contextSettings ? (
                <>
                  <Box className="my-1 h-px w-full bg-border" />
                  <ActionsheetItem
                    testID="composer.plus.contextSettings"
                    isDisabled={contextSettings.disabledReason !== null}
                    onPress={() => {
                      close();
                      // The sheet is a modal of its own: iOS will not present
                      // one while this is still being dismissed.
                      setTimeout(contextSettings.onOpen, SHEET_EXIT_MS);
                    }}
                  >
                    <ActionsheetIcon as={Layers} />
                    <VStack className="flex-1">
                      <ActionsheetItemText>Context settings</ActionsheetItemText>
                      {contextSettings.disabledReason && (
                        <Text testID="composer.plus.contextSettings.reason" size="2xs" className="text-muted-foreground">
                          {contextSettings.disabledReason}
                        </Text>
                      )}
                    </VStack>
                  </ActionsheetItem>
                </>
              ) : null}
              {thinking ? (
                <>
                  <Box className="my-1 h-px w-full bg-border" />
                  <ActionsheetItem
                    testID="composer.plus.thinking"
                    isDisabled={thinking.capability === null}
                    onPress={() => {
                      setPage('thinking');
                    }}
                  >
                    <ActionsheetIcon as={Brain} />
                    <VStack className="flex-1">
                      <ActionsheetItemText>Thinking</ActionsheetItemText>
                      {thinking.capability === null && (
                        <Text testID="composer.plus.thinking.reason" size="2xs" className="text-muted-foreground">
                          {NO_THINKING_REASON}
                        </Text>
                      )}
                    </VStack>
                    {thinking.capability ? (
                      <Text testID="composer.plus.thinking.value" size="sm" className="text-muted-foreground">
                        {selectedThinkingOption(thinking.capability, thinking.level).label}
                      </Text>
                    ) : null}
                    {thinking.capability ? <ActionsheetIcon as={ChevronRight} /> : null}
                  </ActionsheetItem>
                </>
              ) : null}
              {mcp ? (
                <>
                  <Box className="my-1 h-px w-full bg-border" />
                  <ActionsheetItem
                    testID="composer.plus.mcp"
                    onPress={() => {
                      setPage('mcp');
                    }}
                  >
                    <ActionsheetIcon as={Plug} />
                    <ActionsheetItemText className="flex-1">MCP</ActionsheetItemText>
                    <ActionsheetIcon as={ChevronRight} />
                  </ActionsheetItem>
                </>
              ) : null}
            </>
          ) : (
            <Box className="w-full">
              <Pressable
                testID="composer.mcp.back"
                onPress={() => {
                  setPage('main');
                }}
                className="flex-row items-center gap-2 px-3 py-3"
              >
                <Icon as={ChevronLeft} size="sm" className="text-foreground" />
                <Text size="md" className="font-semibold text-foreground">MCP</Text>
              </Pressable>
              {/* Bounded and scrollable: a sheet sizes to its content, and a
                  long server list would otherwise push the footer off screen. */}
              <ScrollView style={{ maxHeight: height * 0.6 }}>
                <McpServerList mcp={mcp} onNavigate={close} />
              </ScrollView>
            </Box>
          )}
        </ActionsheetContent>
      </Actionsheet>
    </>
  );
}

/** The level list, swapped into the sheet in place of the main page — the
 * MCP page's pattern, since iOS will not present a second sheet. */
function ThinkingPage({
  thinking,
  capability,
  onBack,
  onChose,
}: {
  thinking: ComposerThinking;
  capability: ModelThinking;
  onBack: () => void;
  onChose: () => void;
}) {
  const selected = selectedThinkingOption(capability, thinking.level);
  return (
    <Box testID="composer.thinking.submenu" className="w-full">
      <Pressable testID="composer.thinking.back" onPress={onBack} className="flex-row items-center gap-2 px-3 py-3">
        <Icon as={ChevronLeft} size="sm" className="text-foreground" />
        <Text size="md" className="font-semibold text-foreground">Thinking</Text>
      </Pressable>
      {thinkingOptions(capability).map((option) => (
        <ActionsheetItem
          key={option.level}
          testID={`composer.thinking.level.${option.level}`}
          aria-selected={option.level === selected.level}
          onPress={() => {
            thinking.onChange(option.level);
            onChose();
          }}
        >
          <ActionsheetItemText className="flex-1">{option.label}</ActionsheetItemText>
          {option.level === selected.level ? <ActionsheetIcon as={Check} /> : null}
        </ActionsheetItem>
      ))}
      {levelChangeRereads(capability) ? (
        <Text size="2xs" className="px-3 pb-2 pt-1 text-muted-foreground">
          Changing it makes the model re-read this conversation once.
        </Text>
      ) : null}
    </Box>
  );
}
