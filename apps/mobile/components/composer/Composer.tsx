import { useState } from 'react';
import {
  Platform,
  ScrollView,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { ArrowUp, Square, ChevronDown, Check } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { Button, ButtonIcon } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Menu, MenuItem, MenuItemLabel, MenuSeparator } from '@/components/ui/menu';
import { Popover, PopoverBackdrop, PopoverContent, PopoverBody } from '@/components/ui/popover';
import { ContextRing } from './ContextRing';
import { SHANNON_MODELS, THINKING_LEVELS, getModelName } from '@/lib/fixtures/models';
import type { ThinkingLevel } from '@/lib/types';

interface ComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  streaming?: boolean;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevel: (level: ThinkingLevel) => void;
  contextPercent?: number;
  contextStats?: { label: string; value: string }[];
  onOpenModelModal?: () => void;
}

const MODEL_GROUPS: { label: string; location: 'server' | 'device' | 'remote' }[] = [
  { label: 'Server Models', location: 'server' },
  { label: 'On-Device Models', location: 'device' },
  { label: 'Remote Models', location: 'remote' },
];

export function Composer({
  onSend,
  onStop,
  streaming,
  selectedModel,
  onSelectModel,
  thinkingLevel,
  onThinkingLevel,
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
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ alignItems: 'center', gap: 8, flexGrow: 1 }}
          style={{ flex: 1 }}
        >
          {/* Model selector */}
          <Menu
            placement="top left"
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className="flex-row items-center gap-1 rounded-sm border border-border px-2 py-1.5"
              >
                <Text size="xs" className="text-foreground">
                  {getModelName(selectedModel)}
                </Text>
                <Icon as={ChevronDown} size="xs" className="text-muted-foreground" />
              </Pressable>
            )}
          >
            {MODEL_GROUPS.flatMap((group) => {
              const models = SHANNON_MODELS.filter((m) => m.location === group.location);
              if (models.length === 0) return [];
              return models.map((m) => (
                <MenuItem key={m.id} textValue={m.display_name} onPress={() => onSelectModel(m.id)}>
                  <HStack className="flex-1 items-center justify-between">
                    <VStack>
                      <MenuItemLabel className="text-sm">{m.display_name}</MenuItemLabel>
                      <Text size="2xs" className="text-muted-foreground">
                        {m.quant} · {(m.context_tokens / 1000).toFixed(0)}K
                        {m.location === 'remote' && m.price > 0 ? ` · $${m.price.toFixed(2)}/1M` : ''}
                      </Text>
                    </VStack>
                    {m.id === selectedModel && <Icon as={Check} size="xs" className="text-primary" />}
                  </HStack>
                </MenuItem>
              ));
            })}
            {onOpenModelModal && (
              <>
                <MenuSeparator />
                <MenuItem textValue="Search models" onPress={onOpenModelModal}>
                  <MenuItemLabel className="text-sm">Search models...</MenuItemLabel>
                </MenuItem>
              </>
            )}
          </Menu>

          {/* Thinking level chips */}
          <HStack space="xs">
            {THINKING_LEVELS.map((level) => (
              <Pressable
                key={level}
                onPress={() => onThinkingLevel(level)}
                className={`rounded-full px-2 py-1 ${
                  thinkingLevel === level ? 'bg-primary/15' : 'bg-muted'
                }`}
              >
                <Text size="2xs" className={thinkingLevel === level ? 'text-primary' : 'text-muted-foreground'}>
                  {level}
                </Text>
              </Pressable>
            ))}
          </HStack>

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
        </ScrollView>

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
