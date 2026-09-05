import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { formatTokens } from './KpiCard';
import type { ModelStats } from '@loxaic/api-client';

function fmt(n: number | null, digits = 0): string {
  return n === null ? '—' : n.toFixed(digits);
}

function PercentileRow({ label, value, max }: { label: string; value: number | null; max: number }) {
  const pct = value !== null && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <HStack space="xs" className="items-center">
      <Text size="2xs" className="w-8 text-muted-foreground">
        {label}
      </Text>
      <Box className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        {/* eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- must stay a raw numeric interpolation: TS only infers the `${number}%` literal type RN's DimensionValue needs when the placeholder's own type is `number`; String(pct) widens it to `string` and breaks the style prop's type. */}
        <Box className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </Box>
      <Text size="2xs" className="w-12 text-right text-muted-foreground">
        {value === null ? '—' : `${String(Math.round(value))}ms`}
      </Text>
    </HStack>
  );
}

export function ModelStatsTable({ models }: { models: ModelStats[] }) {
  if (models.length === 0) {
    return (
      <Text size="xs" className="text-muted-foreground">
        No model usage in this range
      </Text>
    );
  }

  return (
    <VStack space="md">
      {models.map((m) => {
        const maxTtft = Math.max(m.ttftP50 ?? 0, m.ttftP95 ?? 0, m.ttftP99 ?? 0, 1);
        return (
          <Box key={m.model} className="rounded-md border border-border bg-card p-3">
            <HStack className="items-center justify-between">
              <Text className="font-medium text-foreground" numberOfLines={1}>
                {m.model}
              </Text>
              <Text size="xs" className="text-muted-foreground">
                {m.conversations} conv{m.conversations === 1 ? '' : 's'}
              </Text>
            </HStack>
            <HStack space="lg" className="mt-2">
              <VStack>
                <Text size="2xs" className="text-muted-foreground">
                  Tokens
                </Text>
                <Text size="sm" className="text-foreground">
                  {formatTokens(m.tokens)}
                </Text>
              </VStack>
              <VStack>
                <Text size="2xs" className="text-muted-foreground">
                  Cache %
                </Text>
                <Text size="sm" className="text-foreground">
                  {m.cachePct}%
                </Text>
              </VStack>
              <VStack>
                <Text size="2xs" className="text-muted-foreground">
                  pp / tg
                </Text>
                <Text size="sm" className="text-foreground">
                  {fmt(m.ppSpeed)} / {fmt(m.tgSpeed)}
                </Text>
              </VStack>
            </HStack>
            <VStack space="xs" className="mt-3">
              <PercentileRow label="p50" value={m.ttftP50} max={maxTtft} />
              <PercentileRow label="p95" value={m.ttftP95} max={maxTtft} />
              <PercentileRow label="p99" value={m.ttftP99} max={maxTtft} />
            </VStack>
          </Box>
        );
      })}
    </VStack>
  );
}
