import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';

export function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Box className="min-w-[140px] flex-1 rounded-md border border-border bg-card p-3">
      <Text size="2xs" className="text-muted-foreground">
        {label}
      </Text>
      <Text size="lg" className="mt-1 font-semibold text-foreground">
        {value}
      </Text>
    </Box>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}
