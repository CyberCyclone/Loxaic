import { useEffect, useState } from 'react';
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
import { Spinner } from '@/components/ui/spinner';
import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from '@/lib/types';

interface ModelModalProps {
  open: boolean;
  onClose: () => void;
  models: ModelInfo[];
  loading: boolean;
  error: boolean;
  onRefresh: () => void;
  selectedModel: string;
  onSelect: (modelId: string) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevel: (level: ThinkingLevel) => void;
  onOpenSettings: () => void;
}

const GROUPS: { label: string; location: 'server' | 'device' | 'remote' }[] = [
  { label: 'Server Models', location: 'server' },
  { label: 'On-Device Models', location: 'device' },
  { label: 'Remote Models (Cloud)', location: 'remote' },
];

type Row = { type: 'header'; label: string } | { type: 'model'; model: ModelInfo };

export function ModelModal({
  open,
  onClose,
  models,
  loading,
  error,
  onRefresh,
  selectedModel,
  onSelect,
  thinkingLevel,
  onThinkingLevel,
  onOpenSettings,
}: ModelModalProps) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setSearch('');
      onRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = models.filter(
    (m) =>
      m.display_name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase()),
  );

  const rows: Row[] = GROUPS.flatMap((g) => {
    const groupModels = filtered.filter((m) => m.location === g.location);
    if (groupModels.length === 0) return [];
    return [{ type: 'header' as const, label: g.label }, ...groupModels.map((m) => ({ type: 'model' as const, model: m }))];
  });

  const isEmpty = rows.length === 0;

  return (
    <Modal isOpen={open} onClose={onClose} size="sm">
      <ModalBackdrop />
      <ModalContent className="max-h-[80%]">
        <ModalHeader>
          <Heading size="sm">Select Model</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <Box className="border-b border-border px-4 pb-3">
          <Input className="border-border bg-card">
            <InputField placeholder="Search models..." value={search} onChangeText={setSearch} />
          </Input>
        </Box>
        <ModalBody className="p-0">
          {isEmpty ? (
            <VStack space="sm" className="items-center justify-center py-10">
              {loading ? (
                <Spinner />
              ) : (
                <Text size="sm" className="text-muted-foreground">
                  {error ? 'Inference backend unreachable' : 'No models available'}
                </Text>
              )}
            </VStack>
          ) : (
            // ModalBody is a ScrollView (see components/ui/modal) — a virtualized
            // FlatList can't nest inside one, so this list is a plain map.
            rows.map((item, i) =>
              item.type === 'header' ? (
                <Text
                  key={`h${String(i)}`}
                  size="2xs"
                  className="px-4 pt-3 pb-1 uppercase tracking-wider text-muted-foreground"
                >
                  {item.label}
                </Text>
              ) : (
                <Pressable
                  key={item.model.id}
                  onPress={() => {
                    onSelect(item.model.id);
                    onClose();
                  }}
                  className={`flex-row items-center justify-between px-4 py-2.5 web:hover:bg-muted/30 ${
                    item.model.id === selectedModel ? 'bg-primary/10' : ''
                  }`}
                >
                  <VStack>
                    <HStack space="xs" className="items-center">
                      <Text size="sm" className="font-medium text-foreground">
                        {item.model.display_name}
                      </Text>
                      {item.model.format !== '—' && (
                        <Box className="rounded-sm border border-border bg-muted px-1 py-0.5">
                          <Text size="2xs" className="font-medium uppercase text-muted-foreground">
                            {item.model.format}
                          </Text>
                        </Box>
                      )}
                    </HStack>
                    <Text size="2xs" className="text-muted-foreground">
                      {item.model.quant} · {(item.model.context_tokens / 1024).toFixed(0)}K ctx
                      {/* A model loaded far below its ceiling is the usual reason
                          the context meter looks wrong, so show both figures. */}
                      {item.model.max_context_tokens > item.model.context_tokens
                        ? ` of ${(item.model.max_context_tokens / 1024).toFixed(0)}K`
                        : ''}
                      {item.model.price > 0 ? ` · $${item.model.price.toFixed(2)}/1M` : ' · local'}
                      {item.model.loaded ? ' · loaded' : ''}
                    </Text>
                  </VStack>
                  {item.model.id === selectedModel && <Icon as={Check} size="sm" className="text-primary" />}
                </Pressable>
              ),
            )
          )}
        </ModalBody>
        <ModalFooter className="justify-between border-t border-border">
          <HStack space="xs" className="items-center">
            <Text size="2xs" className="text-muted-foreground">
              Thinking
            </Text>
            {THINKING_LEVELS.map((level) => (
              <Pressable
                key={level}
                onPress={() => { onThinkingLevel(level); }}
                className={`rounded-md border px-2.5 py-1 ${
                  thinkingLevel === level ? 'border-primary bg-primary' : 'border-border bg-background'
                }`}
              >
                <Text size="2xs" className={thinkingLevel === level ? 'text-primary-foreground' : 'text-muted-foreground'}>
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
