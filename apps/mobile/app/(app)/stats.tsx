import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { KpiCard, formatTokens } from '@/components/stats/KpiCard';
import { TokensChart } from '@/components/stats/TokensChart';
import { ModelStatsTable } from '@/components/stats/ModelStatsTable';
import { ConversationStatsTable } from '@/components/stats/ConversationStatsTable';
import { useStats } from '@/hooks/useStats';
import { useSession } from '@/lib/session';
import type { StatsRange } from '@shannon/api-client';

const RANGES: StatsRange[] = ['session', 'today', 'week', 'month', 'year'];

export default function StatsScreen() {
  const shell = useShell();
  const { token } = useSession();
  const [range, setRange] = useState<StatsRange>('today');
  const { usage, series, models, conversations, loading } = useStats(token, range);

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Usage & Performance" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />

      <HStack space="xs" className="px-3 pt-3">
        {RANGES.map((r) => (
          <Pressable
            key={r}
            onPress={() => setRange(r)}
            className={`rounded-full px-3 py-1.5 ${range === r ? 'bg-primary/15' : 'bg-muted'}`}
          >
            <Text size="xs" className={range === r ? 'text-primary' : 'text-muted-foreground'}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </Text>
          </Pressable>
        ))}
      </HStack>

      <ScrollView contentContainerStyle={{ padding: 12, gap: 16 }}>
        {loading && !usage ? (
          <Box className="items-center justify-center py-12">
            <Spinner />
          </Box>
        ) : (
          <>
            <HStack space="sm" className="flex-wrap">
              <KpiCard label="Total Tokens" value={usage ? formatTokens(usage.totalTokens) : '—'} />
              <KpiCard label="Cache Hit %" value={usage ? `${usage.cacheHitRate}%` : '—'} />
              <KpiCard label="Avg TTFT" value={usage?.avgTtftMs != null ? `${Math.round(usage.avgTtftMs)}ms` : '—'} />
              <KpiCard
                label="Avg Gen tok/s"
                value={usage?.avgPredictedTps != null ? usage.avgPredictedTps.toFixed(1) : '—'}
              />
            </HStack>

            <VStack space="xs">
              <Text size="sm" className="font-medium text-foreground">
                Tokens Over Time
              </Text>
              <TokensChart points={series?.points ?? []} />
            </VStack>

            <VStack space="xs">
              <Text size="sm" className="font-medium text-foreground">
                Per-Model Usage
              </Text>
              <ModelStatsTable models={models} />
            </VStack>

            <VStack space="xs">
              <Text size="sm" className="font-medium text-foreground">
                Recent Conversations
              </Text>
              <ConversationStatsTable conversations={conversations} />
            </VStack>
          </>
        )}
      </ScrollView>
    </VStack>
  );
}
