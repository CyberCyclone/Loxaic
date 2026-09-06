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
import { KpiCard, formatTokens, type KpiDelta } from '@/components/stats/KpiCard';
import { TokensChart } from '@/components/stats/TokensChart';
import { CacheRateChart } from '@/components/stats/CacheRateChart';
import { ModelSpeedChart } from '@/components/stats/ModelSpeedChart';
import { ModelStatsTable } from '@/components/stats/ModelStatsTable';
import { ConversationStatsTable } from '@/components/stats/ConversationStatsTable';
import { useStats } from '@/hooks/useStats';
import { useSession } from '@/lib/session';
import type { StatsRange } from '@loxaic/api-client';

const RANGES: StatsRange[] = ['session', 'today', 'week', 'month', 'year'];

type DeltaKind = 'pct-relative' | 'pct-point' | 'ms' | 'raw';

/** cur vs. prev → a KpiCard delta badge. Direction is purely magnitude (up=increase), same as the design source — the accompanying hint text (e.g. "lower is better") carries the metric-specific meaning, not the color. */
function computeDelta(cur: number | null | undefined, prev: number | null | undefined, kind: DeltaKind): KpiDelta | null {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (diff === 0) return null;
  const dir: KpiDelta['dir'] = diff > 0 ? 'up' : 'down';
  const arrow = dir === 'up' ? '↑' : '↓';
  switch (kind) {
    case 'pct-relative': {
      if (prev === 0) return null;
      return { text: `${arrow} ${Math.abs((diff / prev) * 100).toFixed(1)}%`, dir };
    }
    case 'pct-point':
      return { text: `${arrow} ${Math.abs(diff).toFixed(1)}%`, dir };
    case 'ms':
      return { text: `${arrow} ${String(Math.abs(Math.round(diff)))}ms`, dir };
    case 'raw':
      return { text: `${arrow} ${Math.abs(diff).toFixed(1)}`, dir };
  }
}

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
            onPress={() => { setRange(r); }}
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
              <KpiCard
                label="Total Tokens"
                value={usage ? formatTokens(usage.totalTokens) : '—'}
                delta={computeDelta(usage?.totalTokens, usage?.previous?.totalTokens, 'pct-relative')}
                hint={usage?.previous ? 'vs previous period' : undefined}
                spark={usage?.spark?.totalTokens}
              />
              <KpiCard
                label="Prompt Reuse %"
                value={usage?.cacheHitRate != null ? `${String(usage.cacheHitRate)}%` : '—'}
                delta={computeDelta(usage?.cacheHitRate, usage?.previous?.cacheHitRate, 'pct-point')}
                hint={usage?.previous ? 'vs previous period' : undefined}
                spark={usage?.spark?.cacheHitRate}
              />
              <KpiCard
                label="Avg TTFT"
                value={usage?.avgTtftMs != null ? `${String(Math.round(usage.avgTtftMs))}ms` : '—'}
                delta={computeDelta(usage?.avgTtftMs, usage?.previous?.avgTtftMs, 'ms')}
                hint="lower is better"
                spark={usage?.spark?.avgTtftMs}
              />
              <KpiCard
                label="Avg Gen tok/s"
                value={usage?.avgPredictedTps != null ? usage.avgPredictedTps.toFixed(1) : '—'}
                delta={computeDelta(usage?.avgPredictedTps, usage?.previous?.avgPredictedTps, 'raw')}
                hint={usage?.previous ? 'vs previous period' : undefined}
                spark={usage?.spark?.avgPredictedTps}
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
                Prompt Reuse
              </Text>
              <CacheRateChart points={series?.cachePoints ?? []} />
            </VStack>

            <VStack space="xs">
              <Text size="sm" className="font-medium text-foreground">
                Inference Speed by Model
              </Text>
              <ModelSpeedChart models={models} />
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
