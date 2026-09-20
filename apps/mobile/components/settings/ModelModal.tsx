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
import { TRUNCATE_TEXT } from '@/lib/truncate';
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
  /** Model references this user last sent with, newest first. */
  recentModels: string[];
  thinkingLevel: ThinkingLevel;
  onThinkingLevel: (level: ThinkingLevel) => void;
  /**
   * Omit the thinking selector, for a caller with nowhere to put the answer.
   *
   * A routine's runs are started by the server, which reads no per-conversation
   * thinking preference — so the row would be four buttons that silently do
   * nothing, which is worse than not offering them.
   */
  hideThinking?: boolean;
  onOpenSettings: () => void;
}

/**
 * How many recents get their own section at the top.
 *
 * Fewer than the server keeps: the point is that the model you used an hour
 * ago is reachable without scrolling, and a section long enough to scroll
 * would be the problem it was added to solve.
 */
const RECENT_SHOWN = 5;

/**
 * How many models one provider shows before the rest are behind a search.
 *
 * OpenRouter lists several hundred, and this list is a plain `.map` inside a
 * ScrollView (a virtualized FlatList cannot nest in one) — so every row is
 * mounted. Scrolling past three hundred rows to reach a second provider is
 * also not a way anyone finds a model.
 */
const GROUP_CAP = 50;

type Row =
  | { type: 'header'; label: string; testID: string }
  | { type: 'model'; model: ModelInfo; testID: string }
  | { type: 'more'; count: number; key: string };

export function ModelModal({
  open,
  onClose,
  models,
  loading,
  error,
  onRefresh,
  selectedModel,
  onSelect,
  recentModels,
  thinkingLevel,
  onThinkingLevel,
  hideThinking,
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

  const needle = search.trim().toLowerCase();
  const filtered = models.filter(
    (m) =>
      m.display_name.toLowerCase().includes(needle) ||
      m.id.toLowerCase().includes(needle) ||
      // Searching for the provider is how you find "that OpenRouter model",
      // which is the name a user remembers when they can't remember the model.
      m.provider_name.toLowerCase().includes(needle),
  );

  const rows: Row[] = [];

  // Recents first, and only with an empty search box. While searching, a model
  // matching both its group and this section would render twice, and every
  // duplicate is another row to read past on the way to the right one.
  if (!needle) {
    const recent = recentModels
      .map((ref) => models.find((m) => m.id === ref))
      // A reference whose provider was deleted, or whose model an admin has
      // since disallowed, is simply not offered — it cannot be selected.
      .filter((m): m is ModelInfo => m !== undefined)
      .slice(0, RECENT_SHOWN);
    if (recent.length > 0) {
      rows.push({ type: 'header', label: 'Recently used', testID: 'models.group.recent' });
      // Rendered again in their own provider's group below, so a group stays a
      // complete list of what that provider serves.
      rows.push(...recent.map((m): Row => ({ type: 'model', model: m, testID: `models.recent.${m.id}` })));
    }
  }

  // Then every model, grouped by the backend serving it, in the order the
  // server listed them — which puts the built-in backend first.
  const order: string[] = [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of filtered) {
    let group = byProvider.get(m.provider_id);
    if (!group) {
      group = [];
      byProvider.set(m.provider_id, group);
      order.push(m.provider_id);
    }
    group.push(m);
  }
  for (const providerId of order) {
    const group = byProvider.get(providerId) ?? [];
    rows.push({
      type: 'header',
      label: group[0].provider_name,
      testID: `models.group.${providerId}`,
    });
    rows.push(
      ...group.slice(0, GROUP_CAP).map((m): Row => ({ type: 'model', model: m, testID: `models.row.${m.id}` })),
    );
    if (group.length > GROUP_CAP) {
      rows.push({ type: 'more', count: group.length - GROUP_CAP, key: `more-${providerId}` });
    }
  }

  const isEmpty = rows.length === 0;

  return (
    <Modal isOpen={open} onClose={onClose} size="sm">
      <ModalBackdrop />
      {/* Both halves are needed, and neither is cosmetic. The vendored
          ModalBody hardcodes `scrollEnabled={false}` before its prop spread,
          and ModalContent has no height cap of its own — so without them a
          list longer than the viewport simply extends past its edge with
          nothing able to bring the rest into view. Grouping by provider is
          exactly what makes this list long. */}
      <ModalContent testID="models.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Select Model</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <Box className="border-b border-border px-4 pb-3">
          <Input className="border-border bg-card">
            <InputField
              testID="models.search"
              placeholder="Search models or providers..."
              value={search}
              onChangeText={setSearch}
            />
          </Input>
        </Box>
        <ModalBody className="p-0" scrollEnabled>
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
                  key={`h${String(i)}-${item.testID}`}
                  testID={item.testID}
                  size="2xs"
                  className="px-4 pt-3 pb-1 uppercase tracking-wider text-muted-foreground"
                >
                  {item.label}
                </Text>
              ) : item.type === 'more' ? (
                <Text key={item.key} size="2xs" className="px-4 pb-2 pt-1 text-muted-foreground">
                  {item.count} more — search to narrow
                </Text>
              ) : (
                <Pressable
                  // Keyed by the row, not the model: a recent model is rendered
                  // twice, once here and once in its own provider's group.
                  key={item.testID}
                  testID={item.testID}
                  onPress={() => {
                    onSelect(item.model.id);
                    onClose();
                  }}
                  className={`flex-row items-center justify-between px-4 py-2.5 web:hover:bg-muted/30 ${
                    item.model.id === selectedModel ? 'bg-primary/10' : ''
                  }`}
                >
                  <VStack className="min-w-0 shrink">
                    <HStack space="xs" className="items-center">
                      <Text size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                        {item.model.display_name}
                      </Text>
                      {item.model.format !== '—' && (
                        <Box className="shrink-0 rounded-sm border border-border bg-muted px-1 py-0.5">
                          <Text size="2xs" className="font-medium uppercase text-muted-foreground">
                            {item.model.format}
                          </Text>
                        </Box>
                      )}
                    </HStack>
                    <Text size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                      {item.model.quant} · {(item.model.context_tokens / 1024).toFixed(0)}K ctx
                      {/* A model loaded far below its ceiling is the usual reason
                          the context meter looks wrong, so show both figures. */}
                      {item.model.max_context_tokens > item.model.context_tokens
                        ? ` of ${(item.model.max_context_tokens / 1024).toFixed(0)}K`
                        : ''}
                      {/* Keyed on where the model runs, not on its price. A
                          provider that reports no pricing — OpenAI reports
                          none — would otherwise be labelled "local", which is
                          the one thing a cloud model is not. */}
                      {item.model.location === 'remote'
                        ? item.model.price > 0
                          ? ` · $${item.model.price.toFixed(2)}/1M`
                          : ''
                        : ' · local'}
                      {item.model.loaded && item.model.location !== 'remote' ? ' · loaded' : ''}
                      {/* Which machine serves this model. Null on an instance
                          with no registered host identity (a dev server), so
                          nothing is shown rather than a made-up name. With one
                          host this is already how a user names the machine
                          they're talking to; #78 makes the list longer. */}
                      {item.model.host_name ? ` · ${item.model.host_name}` : ''}
                    </Text>
                  </VStack>
                  {item.model.id === selectedModel && (
                    <Icon as={Check} size="sm" className="shrink-0 text-primary" />
                  )}
                </Pressable>
              ),
            )
          )}
        </ModalBody>
        <ModalFooter className="justify-between border-t border-border">
          <HStack space="xs" className="items-center">
            {hideThinking ? null : (
              <>
                <Text size="2xs" className="text-muted-foreground">
                  Thinking
                </Text>
                {THINKING_LEVELS.map((level) => (
                  <Pressable
                    key={level}
                    testID={`models.thinking.${level}`}
                    onPress={() => { onThinkingLevel(level); }}
                    className={`rounded-md border px-2.5 py-1 ${
                      thinkingLevel === level ? 'border-primary bg-primary' : 'border-border bg-background'
                    }`}
                  >
                    <Text
                      size="2xs"
                      className={thinkingLevel === level ? 'text-primary-foreground' : 'text-muted-foreground'}
                    >
                      {level}
                    </Text>
                  </Pressable>
                ))}
              </>
            )}
          </HStack>
          <Pressable
            testID="models.settings"
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
