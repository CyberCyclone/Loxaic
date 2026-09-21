import { useEffect, useState } from 'react';
import { Text } from '@/components/ui/text';
import { deadlineSentence, type WaitKind } from '@/lib/waitSettings';
import type { WaitDeadline } from '@/lib/pendingWaits';

/**
 * What a parked run will do if nobody answers, and when — ticking down.
 *
 * Without it, a wait's length is a setting nobody can see from the question,
 * and its outcome a surprise: the check-in that answered for someone while
 * they were away is the whole reason this exists. Renders nothing when the
 * server sent no deadline (an older server).
 */
export function DeadlineCountdown({
  kind,
  deadline,
  onTimeout,
  unattended,
  autoContinues,
  testID,
}: {
  kind: WaitKind;
  deadline: WaitDeadline | undefined;
  onTimeout?: 'continue' | 'answer';
  unattended?: number;
  autoContinues?: number;
  testID: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!deadline) return;
    // Once a second is plenty for a countdown in m:ss.
    const id = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, [deadline]);

  if (!deadline) return null;
  return (
    <Text testID={testID} size="xs" className="text-muted-foreground">
      {deadlineSentence({
        kind,
        remainingMs: deadline.deadlineAt - now,
        timeoutMs: deadline.timeoutMs,
        basis: deadline.basis,
        onTimeout,
        unattended,
        autoContinues,
      })}
    </Text>
  );
}
