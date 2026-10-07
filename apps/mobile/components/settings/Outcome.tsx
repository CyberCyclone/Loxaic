import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';

/** One branch of a two-way setting, spelled out. The branch in force is
 * readable; the other stays visible but dimmed, so the consequence of flipping
 * the switch is on screen before you flip it. */
export function Outcome({
  active,
  label,
  body,
  testID,
}: {
  active: boolean;
  label: string;
  body: string;
  testID: string;
}) {
  return (
    <Box
      className={`rounded-md border px-2.5 py-2 ${
        active ? 'border-border bg-card' : 'border-transparent bg-muted/30'
      }`}
    >
      <Text size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
        <Text size="2xs" className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>
          {label}
          {active ? ' (current)' : ''}:{' '}
        </Text>
        <Text testID={testID} size="2xs" className={active ? 'text-foreground' : 'text-muted-foreground'}>
          {body}
        </Text>
      </Text>
    </Box>
  );
}
