import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Download, Eye, Heart, Lock, Search } from 'lucide-react-native';
import { searchHfModels, type HfSearchResult, type HfSort } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Input, InputField, InputIcon, InputSlot } from '@/components/ui/input';
import { PresetChips } from '@/components/settings/PresetChips';
import { FitBadge } from './FitBadge';
import { formatCount, formatParams } from '@/lib/localModels';
import { TRUNCATE_TEXT } from '@/lib/truncate';

const SEARCH_DEBOUNCE_MS = 300;

const SORTS: { value: HfSort; label: string }[] = [
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'trending', label: 'Trending' },
  { value: 'likes', label: 'Most liked' },
  { value: 'recent', label: 'Recently updated' },
];

/**
 * Search HuggingFace for GGUF models — by model name, publisher, or
 * `publisher/name` — sorted and filtered, each result with its publisher,
 * stats and a fit label for a typical 4-bit quant. Tapping one opens its
 * details: the description, every quant with its own fit label, and Download.
 */
export function DiscoverPanel({ onOpen }: { onOpen: (repo: string) => void }) {
  const [query, setQuery] = useState('');
  const [publisher, setPublisher] = useState('');
  const [sort, setSort] = useState<HfSort>('downloads');
  const [vision, setVision] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest search may land: typing is debounced, but a slow early
  // answer would otherwise overwrite the list for what was typed after it.
  const request = useRef(0);

  const run = useCallback(async (q: string, author: string, s: HfSort, v: boolean) => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const { results: found } = await searchHfModels({ q, author, sort: s, vision: v });
      if (mine !== request.current) return;
      setResults(found);
      setError(null);
    } catch (err) {
      if (mine !== request.current) return;
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void run(query, publisher, sort, vision); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [query, publisher, sort, vision, run]);

  const shown = fitsOnly ? results.filter((r) => r.fit === 'will-fit') : results;

  return (
    <FlatList
      testID="localModels.results"
      data={shown}
      keyExtractor={(r) => r.repo}
      contentContainerStyle={{ padding: 12, gap: 8 }}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <VStack space="sm" className="mb-2">
          <Input>
            <InputSlot className="pl-3">
              <InputIcon as={Search} />
            </InputSlot>
            <InputField
              testID="localModels.search"
              value={query}
              onChangeText={setQuery}
              placeholder="Search models — e.g. qwen, or unsloth/qwen"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Input>
          <Input>
            <InputField
              testID="localModels.search.publisher"
              value={publisher}
              onChangeText={setPublisher}
              placeholder="Publisher (optional) — e.g. unsloth, bartowski, ggml-org"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Input>
          <PresetChips
            chips={SORTS.map((s) => ({ value: s.value, label: s.label, key: s.value }))}
            value={sort}
            onChoose={setSort}
            testIDPrefix="localModels.sort"
          />
          <HStack space="xs" className="flex-wrap">
            <Pressable
              testID="localModels.filter.vision"
              onPress={() => { setVision((v) => !v); }}
              className={`mb-1 rounded-full px-3 py-1.5 ${vision ? 'bg-primary/15' : 'bg-muted'}`}
            >
              <Text size="sm" className={vision ? 'text-primary' : 'text-muted-foreground'}>
                Vision models
              </Text>
            </Pressable>
            <Pressable
              testID="localModels.filter.fits"
              onPress={() => { setFitsOnly((v) => !v); }}
              className={`mb-1 rounded-full px-3 py-1.5 ${fitsOnly ? 'bg-primary/15' : 'bg-muted'}`}
            >
              <Text size="sm" className={fitsOnly ? 'text-primary' : 'text-muted-foreground'}>
                Will fit only
              </Text>
            </Pressable>
          </HStack>
          {loading && results.length === 0 && (
            <Box className="items-center py-6">
              <Spinner />
            </Box>
          )}
          {error && (
            <Text testID="localModels.search.error" size="sm" className="text-destructive">
              {error}
            </Text>
          )}
          {!loading && !error && shown.length === 0 && (
            <Text testID="localModels.search.empty" size="sm" className="text-muted-foreground">
              No GGUF models match. Try a shorter name, or clear the publisher.
            </Text>
          )}
        </VStack>
      }
      renderItem={({ item }) => <ResultRow result={item} onOpen={() => { onOpen(item.repo); }} />}
    />
  );
}

function ResultRow({ result, onOpen }: { result: HfSearchResult; onOpen: () => void }) {
  const params = formatParams(result.params);
  const updated = result.lastModified ? new Date(result.lastModified).toLocaleDateString() : null;
  return (
    <Pressable
      testID={`localModels.result.${result.repo}`}
      onPress={onOpen}
      className="rounded-md border border-border bg-card p-3 web:hover:bg-muted/30"
    >
      <HStack className="items-start justify-between">
        <VStack className="min-w-0 flex-1 shrink pr-2">
          <Text className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {result.name}
          </Text>
          <Text size="xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            by {result.publisher}
            {params ? ` · ${params}` : ''}
            {result.architecture ? ` · ${result.architecture}` : ''}
          </Text>
        </VStack>
        <FitBadge label={result.fit} testID={`localModels.result.fit.${result.repo}`} suffix={result.fit === 'unknown' ? undefined : 'at 4-bit'} />
      </HStack>
      <HStack space="md" className="mt-2 flex-wrap items-center">
        <HStack space="xs" className="items-center">
          <Icon as={Download} size="2xs" className="text-muted-foreground" />
          <Text size="2xs" className="text-muted-foreground">
            {formatCount(result.downloads)}
          </Text>
        </HStack>
        <HStack space="xs" className="items-center">
          <Icon as={Heart} size="2xs" className="text-muted-foreground" />
          <Text size="2xs" className="text-muted-foreground">
            {formatCount(result.likes)}
          </Text>
        </HStack>
        {result.vision && (
          <HStack space="xs" className="items-center">
            <Icon as={Eye} size="2xs" className="text-muted-foreground" />
            <Text size="2xs" className="text-muted-foreground">
              vision
            </Text>
          </HStack>
        )}
        {result.gated && (
          <HStack space="xs" className="items-center">
            <Icon as={Lock} size="2xs" className="text-muted-foreground" />
            <Text size="2xs" className="text-muted-foreground">
              gated
            </Text>
          </HStack>
        )}
        {result.license && (
          <Text size="2xs" className="text-muted-foreground">
            {result.license}
          </Text>
        )}
        {updated && (
          <Text size="2xs" className="text-muted-foreground">
            updated {updated}
          </Text>
        )}
        {result.downloaded.length > 0 && (
          <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
            have {result.downloaded.join(', ')}
          </Text>
        )}
      </HStack>
    </Pressable>
  );
}
