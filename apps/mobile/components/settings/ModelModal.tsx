import { useState } from 'react';
import { FlatList } from 'react-native';
import { Check, Settings as SettingsIcon } from 'lucide-react-native';
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
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { CloseIcon } from '@/components/ui/icon';
import { SHANNON_MODELS, THINKING_LEVELS } from '@/lib/fixtures/models';
import type { ThinkingLevel } from '@/lib/types';

interface ModelModalProps {
  open: boolean;
  onClose: () => void;
  selectedModel: string;
  onSelect: (modelId: string) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevel: (level: ThinkingLevel) => void;
  onOpenSettings: () => void;
}

const GROUPS: { label: string; location: 'server' | 'device' | 'remote' }[] = [
  { label: 'Server Models', location: 'server' },
  { label: 'On-Device Models', location: 'device' },
  { label: 'Remote Models', location: 'remote' },
];

type Row = { type: 'header'; label: string } | { type: 'model'; model: (typeof SHANNON_MODELS)[number] };

export function ModelModal({
  open,
  onClose,
  selectedModel,
  onSelect,
  thinkingLevel,
  onThinkingLevel,
  onOpenSettings,
}: ModelModalProps) {
  const [search, setSearch] = useState('');
  const filtered = SHANNON_MODELS.filter((m) =>
    m.display_name.toLowerCase().includes(search.toLowerCase()),
  );

  const rows: Row[] = GROUPS.flatMap((g) => {
    const models = filtered.filter((m) => m.location === g.location);
    if (models.length === 0) return [];
    return [{ type: 'header' as const, label: g.label }, ...models.map((m) => ({ type: 'model' as const, model: m }))];
  });

  return (
    <Modal isOpen={open} onClose={onClose} size="sm">
      <ModalBackdrop />
      <ModalContent className="max-h-[80%]">
        <ModalHeader>
          <Heading size="sm">Select model</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <Box className="border-b border-border px-4 pb-3">
          <Input className="border-border bg-card">
            <InputField placeholder="Search models..." value={search} onChangeText={setSearch} />
          </Input>
        </Box>
        <ModalBody className="p-0" contentContainerStyle={{ flex: 1 }}>
          <FlatList
            data={rows}
            keyExtractor={(r, i) => (r.type === 'header' ? `h${i}` : r.model.id)}
            renderItem={({ item }) =>
              item.type === 'header' ? (
                <Text size="2xs" className="px-4 pt-3 pb-1 uppercase tracking-wider text-muted-foreground">
                  {item.label}
                </Text>
              ) : (
                <Pressable
                  onPress={() => {
                    onSelect(item.model.id);
                    onClose();
                  }}
                  className="flex-row items-center justify-between px-4 py-2.5 web:hover:bg-muted/30"
                >
                  <VStack>
                    <Text size="sm" className="text-foreground">
                      {item.model.display_name}
                    </Text>
                    <Text size="2xs" className="text-muted-foreground">
                      {item.model.quant} · {(item.model.context_tokens / 1000).toFixed(0)}K
                      {item.model.location === 'remote' && item.model.price > 0
                        ? ` · $${item.model.price.toFixed(2)}/1M`
                        : ''}
                    </Text>
                  </VStack>
                  {item.model.id === selectedModel && <Icon as={Check} size="sm" className="text-primary" />}
                </Pressable>
              )
            }
          />
        </ModalBody>
        <ModalFooter className="justify-between border-t border-border">
          <HStack space="xs">
            {THINKING_LEVELS.map((level) => (
              <Pressable
                key={level}
                onPress={() => onThinkingLevel(level)}
                className={`rounded-full px-2 py-1 ${thinkingLevel === level ? 'bg-primary/15' : 'bg-muted'}`}
              >
                <Text size="2xs" className={thinkingLevel === level ? 'text-primary' : 'text-muted-foreground'}>
                  {level}
                </Text>
              </Pressable>
            ))}
          </HStack>
          <Pressable
            onPress={() => {
              onClose();
              onOpenSettings();
            }}
            className="rounded-sm p-1.5 web:hover:bg-muted/50"
          >
            <Icon as={SettingsIcon} size="sm" className="text-muted-foreground" />
          </Pressable>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
