import Svg, { Polyline } from 'react-native-svg';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';

export type KpiDelta = { text: string; dir: 'up' | 'down' };

interface KpiCardProps {
  label: string;
  value: string;
  delta?: KpiDelta | null;
  /** Short semantic note next to the delta, e.g. "vs previous period" or "lower is better". */
  hint?: string;
  /** Compact per-bucket series across the current window — nulls are skipped (gap in the line), not zeroed. */
  spark?: (number | null)[] | null;
}

export function KpiCard({ label, value, delta, hint, spark }: KpiCardProps) {
  return (
    <Box className="min-w-[140px] flex-1 rounded-md border border-border bg-card p-3">
      <Text size="2xs" className="text-muted-foreground">
        {label}
      </Text>
      <Text size="lg" className="mt-1 font-semibold text-foreground">
        {value}
      </Text>
      {(delta || hint) && (
        <HStack space="xs" className="mt-1 items-center">
          {delta && (
            <Box className={`rounded-sm px-1.5 py-0.5 ${delta.dir === 'up' ? 'bg-success/15' : 'bg-destructive/15'}`}>
              <Text size="2xs" className={delta.dir === 'up' ? 'text-success' : 'text-destructive'}>
                {delta.text}
              </Text>
            </Box>
          )}
          {hint && (
            <Text size="2xs" className="text-muted-foreground">
              {hint}
            </Text>
          )}
        </HStack>
      )}
      {spark && spark.some((v) => v != null) && (
        <Box className="mt-2">
          <Sparkline data={spark} />
        </Box>
      )}
    </Box>
  );
}

function Sparkline({ data, height = 32 }: { data: (number | null)[]; height?: number }) {
  const width = 160;
  const known = data.filter((v): v is number => v != null);
  const max = Math.max(...known, 0);
  const min = Math.min(...known, 0);
  const span = max - min || 1;

  const points = data
    .map((v, i): [number, number] | null => {
      if (v == null) return null;
      const x = data.length > 1 ? (i / (data.length - 1)) * width : width / 2;
      const y = height - ((v - min) / span) * height;
      return [x, y];
    })
    .filter((p): p is [number, number] => p !== null);

  if (points.length < 2) return null;

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      <Polyline
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke="#0096ff"
        strokeWidth={1.5}
      />
    </Svg>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}
