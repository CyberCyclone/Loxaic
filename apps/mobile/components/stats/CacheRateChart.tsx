import Svg, { Polyline, Polygon, Line } from 'react-native-svg';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import type { CacheRatePoint } from '@shannon/api-client';

const COLOR = '#0096ff';

interface CacheRateChartProps {
  points: CacheRatePoint[];
  height?: number;
}

export function CacheRateChart({ points, height = 180 }: CacheRateChartProps) {
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
  const padding = { top: 10, right: 10, bottom: 10, left: 28 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const values = points.map((p) => p.cacheHitRate);
  const max = Math.max(...values, 1);
  const x = (i: number) => padding.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => padding.top + plotH - (v / max) * plotH;

  const linePoints = points.map((p, i) => `${x(i)},${y(p.cacheHitRate)}`).join(' ');
  const areaPoints = `${padding.left},${padding.top + plotH} ${linePoints} ${x(points.length - 1)},${padding.top + plotH}`;

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
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
