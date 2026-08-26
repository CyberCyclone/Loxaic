import Svg, { Rect, Line } from 'react-native-svg';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import type { StatsSeriesPoint } from '@shannon/api-client';

// react-native-svg can't resolve CSS custom properties, so the palette is
// literal here rather than theme tokens (same constraint as ContextRing).
const COLORS = ['#0096ff', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6'];

interface TokensChartProps {
  points: StatsSeriesPoint[];
  height?: number;
}

export function TokensChart({ points, height = 180 }: TokensChartProps) {
  if (points.length === 0) {
    return (
      <Box className="items-center justify-center" style={{ height }}>
        <Text size="xs" className="text-muted-foreground">
          No usage yet
        </Text>
      </Box>
    );
  }

  const width = 320;
  const padding = { top: 10, right: 10, bottom: 10, left: 10 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const models = Array.from(new Set(points.flatMap((p) => Object.keys(p.values)))).sort();
  const totals = points.map((p) => models.reduce((sum, m) => sum + (p.values[m] ?? 0), 0));
  const maxVal = Math.max(...totals, 1);
  const barSlot = plotW / points.length;
  const barW = Math.min(28, barSlot * 0.6);

  return (
    <VStack space="xs">
      <Svg width="100%" height={height} viewBox={`0 0 ${String(width)} ${String(height)}`}>
        {[0, 0.5, 1].map((f) => (
          <Line
            key={f}
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + plotH * (1 - f)}
            y2={padding.top + plotH * (1 - f)}
            stroke="rgba(128,128,128,0.2)"
            strokeWidth={1}
          />
        ))}
        {points.map((p, i) => {
          let cum = 0;
          const x = padding.left + i * barSlot + (barSlot - barW) / 2;
          return models.map((m, mi) => {
            const v = p.values[m] ?? 0;
            if (v === 0) return null;
            const barH = plotH * (v / maxVal);
            const y = padding.top + plotH - plotH * (cum / maxVal) - barH;
            cum += v;
            return (
              <Rect
                key={`${p.bucket}-${m}`}
                transform={[{ translateX: x }, { translateY: y }]}
                width={barW}
                height={Math.max(barH, 1)}
                fill={COLORS[mi % COLORS.length]}
                rx={2}
              />
            );
          });
        })}
      </Svg>
      <HStack space="sm" className="flex-wrap px-1">
        {models.map((m, i) => (
          <HStack key={m} space="xs" className="items-center">
            <Box style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS[i % COLORS.length] }} />
            <Text size="2xs" className="text-muted-foreground">
              {m}
            </Text>
          </HStack>
        ))}
      </HStack>
    </VStack>
  );
}
