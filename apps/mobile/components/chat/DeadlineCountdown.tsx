import { useEffect, useState } from 'react';
import { Text } from '@/components/ui/text';
import { deadlineSentence } from '@/lib/waitSettings';
import type { WaitDeadline } from '@/lib/pendingWaits';

/**
 * When a tool approval stops waiting, and that the call then won't run —
 * ticking down. Without it, a wait's length is a setting nobody can see from
 * the question. Renders nothing when the server sent no deadline (an older
 * server).
 */
export function DeadlineCountdown({ deadline, testID }: { deadline: WaitDeadline | undefined; testID: string }) {
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
      {deadlineSentence({ remainingMs: deadline.deadlineAt - now, timeoutMs: deadline.timeoutMs, basis: deadline.basis })}
    </Text>
  );
}
