import { TriangleAlert } from 'lucide-react-native';
import type { ModelPlacement } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  placementLines,
  placementSegments,
  placementSummary,
  placementWarnings,
  tierLabel,
  type PlacementSegmentTier,
} from '@/lib/placement';
import { formatBytes } from '@/lib/localModels';

/** One colour per tier, shared by the bar and the legend dots. Semantic tokens
 * only; moved-out-of-VRAM is the one that means something is wrong. */
const TIER_CLASS: Record<PlacementSegmentTier, string> = {
  gpu: 'bg-primary',
  spill: 'bg-destructive',
  ram: 'bg-success',
  ssd: 'bg-muted-foreground',
};

interface PlacementBarProps {
  placement: ModelPlacement;
  testID: string;
  /** The settings sheet's full form: a legend per tier and a line per part. */
  detailed?: boolean;
}

/**
 * Where a loaded model's memory is: a bar split by VRAM, RAM and the SSD (the
 * same percentage-width segments as the context bar, for the same reason —
 * see ContextBar), a sentence under it, and what is wrong with it, if
 * anything.
 */
export function PlacementBar({ placement, testID, detailed = false }: PlacementBarProps) {
  const segments = placementSegments(placement);
  if (segments.length === 0) return null;
  const warnings = placementWarnings(placement);
  return (
    <VStack testID={testID} space="xs">
      <HStack className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((s) => (
          <Box
            key={s.tier}
            testID={`${testID}.segment.${s.tier}`}
            className={TIER_CLASS[s.tier]}
            style={{ width: (String(s.pct) + '%') as `${number}%` }}
          />
        ))}
      </HStack>
      {detailed ? (
        <HStack space="md" className="flex-wrap">
          {segments.map((s) => (
            <HStack key={s.tier} space="xs" className="items-center">
              <Box className={`h-2 w-2 rounded-full ${TIER_CLASS[s.tier]}`} />
              <Text size="2xs" className="text-muted-foreground">
                {tierLabel(s.tier, placement)} {formatBytes(s.bytes)}
              </Text>
            </HStack>
          ))}
        </HStack>
      ) : (
        <Text testID={`${testID}.summary`} size="2xs" className="text-muted-foreground">
          {placementSummary(placement)}
        </Text>
      )}
      {detailed && (
        <VStack testID={`${testID}.legend`} space="xs">
          {placementLines(placement).map((l) => (
            <Text key={l.part} testID={`${testID}.part.${l.part}`} size="xs" className="text-foreground">
              {l.text}
            </Text>
          ))}
          {placement.measured && (
            <Text size="2xs" className="text-muted-foreground">
              Measured from the process: {formatBytes(placement.measured.vramBytes)} in VRAM, {formatBytes(placement.measured.gttBytes)} mapped from system RAM.
            </Text>
          )}
        </VStack>
      )}
      {warnings.map((w, i) => (
        <HStack key={w} space="xs" className="items-start rounded-md bg-warning/15 p-2">
          <Icon as={TriangleAlert} size="xs" className="mt-0.5 text-warning" />
          {/* The testID is on the text: XCUITest exposes no plain container's. */}
          <Text testID={`${testID}.warning.${String(i)}`} size="xs" className="min-w-0 flex-1 text-foreground">
            {w}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}
