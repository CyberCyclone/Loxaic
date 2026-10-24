import { useEffect, useState } from 'react';
import { AlertCircle, Layers } from 'lucide-react-native';
import { isStageActive, stageCardDetail, stageCardLabel, type StageCard } from '@/lib/stageCard';
import { ContextPill } from './ContextPill';

/**
 * A context-stage switch, as the pill the conversation shows while it runs —
 * the compaction pill's sibling (CompactionCard): waiting for another reply,
 * reloading the model at the new context, re-reading the conversation, and
 * then what came of it. Everything it says comes from the stream's
 * `context.stage` events; see lib/stageCard.ts.
 */
export function ContextStageCard({ card }: { card: StageCard }) {
  // Ticks only while there is a countdown to show.
  const [now, setNow] = useState(() => Date.now());
  const counting = card.status.step === 'reloading' && !!card.status.eta_ms;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, [counting]);

  const failed = card.status.step === 'failed';
  return (
    <ContextPill
      testID="chat.contextStage"
      labelTestID="chat.contextStage.label"
      detailTestID="chat.contextStage.detail"
      active={isStageActive(card)}
      failed={failed}
      icon={failed ? AlertCircle : Layers}
      label={stageCardLabel(card, now)}
      step={card.status.step}
      since={card.since}
      detail={stageCardDetail(card.status)}
      progress={card.status.step === 'rereading' ? card.status.progress : null}
    />
  );
}
