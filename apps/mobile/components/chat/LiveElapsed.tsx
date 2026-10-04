import { useEffect, useState } from 'react';
import { Text } from '@/components/ui/text';

interface LiveElapsedProps {
  /** Epoch ms the response started at (send time) — exact, not estimated. */
  since: number;
  className?: string;
  /** On the Text itself: XCUITest does not expose a wrapping view's. */
  testID?: string;
}

// Ticks a real elapsed-time readout for as long as a response is in flight —
// covering model load, prompt processing, and generation as one continuous
// span. Unlike a tokens/sec estimate, elapsed time needs no guessing: it's
// just `now - since`, so this stays accurate through every phase.
export function LiveElapsed({ since, className, testID }: LiveElapsedProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, 100);
    return () => { clearInterval(id); };
  }, []);

  const elapsedSec = Math.max(0, now - since) / 1000;
  return (
    <Text testID={testID} size="xs" className={className ?? 'text-muted-foreground'}>
      {elapsedSec.toFixed(1)}s
    </Text>
  );
}
