import Svg, { Polyline, Polygon, Line } from 'react-native-svg';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import type { CacheRatePoint } from '@loxaic/api-client';

const COLOR = '#0096ff';

interface CacheRateChartProps {
  points: CacheRatePoint[];
  height?: number;
}

export function CacheRateChart({ points, height = 180 }: CacheRateChartProps) {
  // A bucket with no measured reuse figure is a gap, not a zero — plotting it
  // as 0% is exactly the kind of fabricated data point this whole change is
  // about. Drop those buckets and keep their x position, so a run of
  // unmeasured buckets reads as a gap in the series rather than a dive to the
  // floor.
  const width = 320;
  const padding = { top: 10, right: 10, bottom: 10, left: 28 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const x = (i: number) => padding.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const measured = points
    .map((p, i) => ({ rate: p.cacheHitRate, i }))
    .filter((p): p is { rate: number; i: number } => p.rate != null);

  if (measured.length === 0) {
    return (
      <Box className="items-center justify-center" style={{ height }}>
        <Text size="xs" className="text-muted-foreground">
          {points.length === 0 ? 'No usage yet' : 'Not measured for this period'}
        </Text>
      </Box>
    );
  }

  const max = Math.max(...measured.map((p) => p.rate), 1);
  const y = (v: number) => padding.top + plotH - (v / max) * plotH;

  const linePoints = measured.map((p) => `${String(x(p.i))},${String(y(p.rate))}`).join(' ');
  const areaPoints = `${String(x(measured[0].i))},${String(padding.top + plotH)} ${linePoints} ${String(x(measured[measured.length - 1].i))},${String(padding.top + plotH)}`;

  return (
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
      <Polygon points={areaPoints} fill={COLOR} fillOpacity={0.12} />
      <Polyline points={linePoints} fill="none" stroke={COLOR} strokeWidth={2} />
    </Svg>
  );
}
