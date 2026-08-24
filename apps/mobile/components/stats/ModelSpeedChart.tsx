import { Fragment } from 'react';
import Svg, { Rect } from 'react-native-svg';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import type { ModelStats } from '@shannon/api-client';

const PP_COLOR = '#0096ff';
const TG_COLOR = '#22c55e';

interface ModelSpeedChartProps {
  models: ModelStats[];
  height?: number;
}

// Grouped bar chart: prompt-processing vs generation tok/s, one pair per
// model — a snapshot comparison across models, not a trend over time (the
// design mockup's "Inference Speed by Model" chart is the same shape).
export function ModelSpeedChart({ models, height = 200 }: ModelSpeedChartProps) {
  const withSpeed = models.filter((m) => m.ppSpeed != null || m.tgSpeed != null);

  if (withSpeed.length === 0) {
    return (
      <Box className="items-center justify-center" style={{ height }}>
        <Text size="xs" className="text-muted-foreground">
          No timing data yet
        </Text>
      </Box>
    );
  }

  const width = 320;
  const padding = { top: 10, right: 10, bottom: 28, left: 32 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...withSpeed.flatMap((m) => [m.ppSpeed ?? 0, m.tgSpeed ?? 0]), 1);
  const slot = plotW / withSpeed.length;
  const barW = Math.min(20, slot * 0.28);

  return (
    <VStack space="xs">
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {[0, 0.5, 1].map((f) => (
          <Rect
            key={f}
            x={padding.left}
            y={padding.top + plotH * (1 - f)}
            width={plotW}
            height={0.5}
            fill="rgba(128,128,128,0.2)"
          />
        ))}
        {withSpeed.map((m, i) => {
          const cx = padding.left + i * slot + slot / 2;
          const pp = m.ppSpeed ?? 0;
          const tg = m.tgSpeed ?? 0;
          const ppH = (pp / maxVal) * plotH;
          const tgH = (tg / maxVal) * plotH;
          return (
            <Fragment key={m.model}>
              <Rect
                x={cx - barW - 2}
                y={padding.top + plotH - ppH}
                width={barW}
                height={Math.max(ppH, 1)}
                fill={PP_COLOR}
                rx={2}
              />
              <Rect
                x={cx + 2}
                y={padding.top + plotH - tgH}
                width={barW}
                height={Math.max(tgH, 1)}
                fill={TG_COLOR}
                rx={2}
              />
            </Fragment>
          );
        })}
      </Svg>
      <HStack space="sm" className="flex-wrap px-1">
        {withSpeed.map((m) => (
          <Text key={m.model} size="2xs" className="text-muted-foreground" numberOfLines={1} style={{ maxWidth: 90 }}>
            {m.model}
          </Text>
        ))}
      </HStack>
      <HStack space="sm" className="px-1">
        <HStack space="xs" className="items-center">
          <Box style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: PP_COLOR }} />
          <Text size="2xs" className="text-muted-foreground">
            Prompt processing
          </Text>
        </HStack>
        <HStack space="xs" className="items-center">
          <Box style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TG_COLOR }} />
          <Text size="2xs" className="text-muted-foreground">
            Generation
          </Text>
        </HStack>
      </HStack>
    </VStack>
  );
}
