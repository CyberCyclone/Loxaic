import { useEffect, useState } from 'react';
import { AlertCircle, Layers } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { isStageActive, stageCardDetail, stageCardLabel, type StageCard } from '@/lib/stageCard';
import { LiveElapsed } from './LiveElapsed';
import { PromptProgressBar } from './PromptProgressBar';

/**
 * A context-stage switch, as the pill the conversation shows while it runs —
 * the compaction pill's sibling (CompactionCard): waiting for another reply,
 * reloading the model at the new context, re-reading the conversation, and
 * then what came of it. Everything it says comes from the stream's
 * `context.stage` events; see lib/stageCard.ts.
 */
export function ContextStageCard({ card }: { card: StageCard }) {
  const active = isStageActive(card);
  // Ticks only while there is a countdown to show.
  const [now, setNow] = useState(() => Date.now());
  const counting = card.status.step === 'reloading' && !!card.status.eta_ms;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, [counting]);

  const failed = card.status.step === 'failed';
  const detail = stageCardDetail(card.status);
  const progress = card.status.step === 'rereading' ? card.status.progress : undefined;

  return (
    <Box testID="chat.contextStage" className="my-2 px-4">
      <Box className="mx-auto max-w-[820px] items-center">
        <HStack space="xs" className={`items-center rounded-full border bg-card px-3 py-1.5 ${failed ? 'border-destructive/40' : 'border-border'}`}>
          {active ? (
            <Spinner size="small" className="text-muted-foreground" />
          ) : (
            <Icon as={failed ? AlertCircle : Layers} size="2xs" className={failed ? 'text-destructive' : 'text-muted-foreground'} />
          )}
          <Text
            testID="chat.contextStage.label"
            size="xs"
            className={`shrink ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
            data-step={card.status.step}
          >
            {stageCardLabel(card, now)}
          </Text>
          {active && <LiveElapsed since={card.since} className="text-muted-foreground" />}
        </HStack>
        {detail && (
          <Text testID="chat.contextStage.detail" size="2xs" className="mt-1 text-center text-muted-foreground">
            {detail}
          </Text>
        )}
        {progress && progress.total_tokens > 0 && (
          <Box className="mt-1 w-full max-w-[420px]">
            <PromptProgressBar stats={{ progress }} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
