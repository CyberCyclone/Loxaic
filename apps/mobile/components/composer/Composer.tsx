import { useState } from 'react';
import {
  Platform,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { ArrowUp, Square, ChevronDown, CircleDot } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonIcon } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Popover, PopoverBackdrop, PopoverContent, PopoverBody } from '@/components/ui/popover';
import { ContextRing } from './ContextRing';

interface ComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  streaming?: boolean;
  modelName: string;
  contextPercent?: number;
  contextStats?: { label: string; value: string }[];
  onOpenModelModal: () => void;
}

export function Composer({
  onSend,
  onStop,
  streaming,
  modelName,
  contextPercent = 0,
  contextStats = [],
  onOpenModelModal,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [inputHeight, setInputHeight] = useState(20);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setText('');
    setInputHeight(20);
  };

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (Platform.OS !== 'web') return;
    const nativeEvent = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
    if (nativeEvent.key === 'Enter' && !nativeEvent.shiftKey) {
      e.preventDefault?.();
      send();
    }
  };

  return (
    <Box className="border-t border-border bg-background p-3">
      <VStack space="sm" className="mx-auto w-full max-w-[820px]">
        <Textarea size="md" className="border-border bg-card">
          <TextareaInput
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

          <Box className="flex-1" />

          {/* Context indicator */}
          {contextStats.length > 0 && (
            <Popover
              placement="top left"
              trigger={(triggerProps) => (
                <Pressable {...triggerProps} className="flex-row items-center gap-1 px-1">
                  <ContextRing percent={contextPercent} />
                  <Text size="2xs" className="text-muted-foreground">
                    {contextPercent}%
                  </Text>
                </Pressable>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="w-60">
                <PopoverBody>
                  <VStack space="xs">
                    {contextStats.map((s) => (
                      <HStack key={s.label} className="justify-between">
                        <Text size="xs" className="text-muted-foreground">
                          {s.label}
                        </Text>
                        <Text size="xs" className="text-foreground">
                          {s.value}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
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
