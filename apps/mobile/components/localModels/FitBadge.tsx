import type { FitLabel } from '@loxaic/api-client';
import { Text } from '@/components/ui/text';
import { FIT_CLASS, FIT_TEXT } from '@/lib/localModels';

/**
 * "Will fit" / "Might fit" / "Won't fit" — computed by the server, so every
 * place a model appears says the same thing. Words as well as colour, always.
 */
export function FitBadge({ label, testID, suffix }: { label: FitLabel; testID?: string; suffix?: string }) {
  return (
    <Text testID={testID} size="2xs" className={`shrink-0 rounded-full px-2 py-0.5 ${FIT_CLASS[label]}`}>
      {FIT_TEXT[label]}
      {suffix ? ` ${suffix}` : ''}
    </Text>
  );
}
