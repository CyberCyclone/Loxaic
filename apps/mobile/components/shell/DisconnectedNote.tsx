import { Text } from '@/components/ui/text';
import { disconnectedCopy, showsDisconnected, useConnection } from '@/lib/connection';

/**
 * Why a dialog's or sheet's buttons are greyed out while the server is
 * unreachable.
 *
 * Every Modal and Actionsheet here renders through gluestack's portal, above
 * the shell, so the app's connection banner sits under its backdrop — and a
 * disabled button with no reason reads as a broken one. Silent during a grace
 * period, like the banner, so an ordinary return to the app shows nothing.
 *
 * `what` finishes "you can … once it's back": "answer", "save", "decide on
 * this plan".
 */
export function DisconnectedNote({
  testID,
  what = 'answer',
  className = '',
}: {
  testID: string;
  what?: string;
  className?: string;
}) {
  const connection = useConnection();
  if (!showsDisconnected(connection)) return null;
  return (
    <Text testID={testID} size="xs" className={`text-destructive ${className}`}>
      {disconnectedCopy(connection).note(what)}
    </Text>
  );
}
