import { AlertCircle, DatabaseZap } from 'lucide-react-native';
import type { PromptCacheStatus } from '@loxaic/api-client';
import { promptCacheActive, promptCacheBar, promptCacheLabel } from '@/lib/promptCache';
import { ContextPill } from './ContextPill';

/**
 * A saved KV cache going back into the model before this reply — the context
 * pills' sibling, so a conversation whose model was reloaded shows the cache
 * loading (and how far) instead of a silent wait. From the stream's
 * `prompt.cache` events; see lib/promptCache.ts.
 */
export function PromptCacheCard({ status }: { status: PromptCacheStatus }) {
  const failed = status.step === 'failed';
  return (
    <ContextPill
      testID="chat.promptCache.pill"
      labelTestID="chat.promptCache.pill.label"
      active={promptCacheActive(status)}
      failed={failed}
      icon={failed ? AlertCircle : DatabaseZap}
      label={promptCacheLabel(status)}
      step={status.step}
      since={status.started_at}
      progress={promptCacheBar(status)?.progress ?? null}
    />
  );
}
