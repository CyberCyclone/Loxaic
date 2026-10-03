import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { PresetChips } from '@/components/settings/PresetChips';
import { formatBytes } from '@/lib/localModels';
import { TABLE_VRAM_REASON, tableRamWarning } from '@/lib/placement';

interface LookupTableSectionProps {
  value: unknown;
  tableBytes: number;
  help: string;
  host: { totalBytes: number; freeBytes: number } | undefined;
  onChoose: (value: string | null) => void;
}

/**
 * Where a model's per-layer lookup table lives (Qwen3.8-Flash-Next's is 27.5
 * GB): read from the model file as rows are needed, or copied into RAM. VRAM
 * is shown and not offered, with why — an admin who came looking for it should
 * not have to wonder whether it was forgotten.
 */
export function LookupTableSection({ value, tableBytes, help, host, onChoose }: LookupTableSectionProps) {
  const warning = tableRamWarning(value, tableBytes, host);
  return (
    <VStack space="xs">
      <Text size="sm" className="text-foreground">
        Lookup table ({formatBytes(tableBytes)})
      </Text>
      <HStack space="xs" className="flex-wrap items-center">
        <PresetChips
          chips={[
            { value: '', label: 'Automatic', key: 'default' },
            { value: 'ssd', label: 'SSD', key: 'ssd' },
            { value: 'ram', label: 'RAM', key: 'ram' },
          ]}
          value={typeof value === 'string' && value !== 'auto' ? value : ''}
          onChoose={(v) => { onChoose(v === '' ? null : v); }}
          testIDPrefix="localModels.setting.tablePlacement"
        />
        <Pressable
          testID="localModels.setting.tablePlacement.vram"
          disabled
          accessibilityState={{ disabled: true }}
          className="mb-1 rounded-full bg-muted px-3 py-1.5 opacity-50"
        >
          <Text size="sm" className="text-muted-foreground">
            VRAM
          </Text>
        </Pressable>
      </HStack>
      <Text size="2xs" className="text-muted-foreground">
        {help} Automatic reads it from the SSD when it is over 4 GB.
      </Text>
      <Text testID="localModels.setting.tablePlacement.vramReason" size="2xs" className="text-muted-foreground">
        VRAM: {TABLE_VRAM_REASON}
      </Text>
      {warning && (
        <Text testID="localModels.setting.tablePlacement.warning" size="2xs" className="text-warning">
          {warning}
        </Text>
      )}
    </VStack>
  );
}
