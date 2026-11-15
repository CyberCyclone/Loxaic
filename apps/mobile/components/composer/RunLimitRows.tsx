import { HStack } from '@/components/ui/hstack';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { RunLimitSwitches } from '@/hooks/useRunLimits';

/**
 * This conversation's progress review, as a switch. In the `+` menu on every
 * platform, and the menu stays open on a press: what the switch did is written
 * on its row.
 */
export function RunLimitRows({ limits }: { limits: RunLimitSwitches }) {
  return (
    <VStack testID="composer.plus.limits" className="w-full min-w-0">
      {limits.rows.map((row) => (
        <HStack key={row.key} className="min-w-0 items-center gap-3 rounded-md px-3 py-2">
          <VStack className="min-w-0 flex-1">
            <Text size="sm" className="text-foreground">
              {row.label}
            </Text>
            <Text testID={`${row.testID}.state`} size="2xs" className="text-muted-foreground">
              {row.sublabel}
            </Text>
          </VStack>
          <Switch
            testID={row.testID}
            size="sm"
            value={row.on}
            disabled={!limits.canToggle}
            onValueChange={(on) => { limits.toggle(row.key, on); }}
          />
        </HStack>
      ))}
      {limits.lockedReason ? (
        <Text testID="composer.plus.limits.locked" size="2xs" className="px-3 pb-1 text-muted-foreground">
          {limits.lockedReason}
        </Text>
      ) : null}
    </VStack>
  );
}
