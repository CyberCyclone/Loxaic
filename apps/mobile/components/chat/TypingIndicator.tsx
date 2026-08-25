import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { LiveElapsed } from './LiveElapsed';

interface TypingIndicatorProps {
  /** True when the backend reported the target model isn't loaded yet (LM Studio JIT load). */
  loadingModel?: boolean;
  /** Epoch ms the response started at (send time) — the same clock the eventual live Message elapsed readout continues from. */
  since: number;
  /** Model the request was sent to — shown the same way Message shows it, so this doesn't read as a headerless indicator. */
  model?: string;
}

// Shown only before *any* token (reasoning or answer) has streamed — once
// the model actually starts reasoning, that's real chain-of-thought and
// gets its own live ThinkingBlock instead of this generic label. So this
// window is genuinely prompt evaluation (prefill), not "thinking" — label
// it that way instead of overclaiming.
//
// No tok/s here: unlike generation, prefill is one atomic batched compute on
// the backend with zero incremental signal — the first thing we ever hear
// back *is* the first generated token, which is also what ends this phase.
// So there's nothing to count until it's already over. An elapsed-time
// counter is the honest version of "live feedback" for this window.
export function TypingIndicator({ loadingModel, since, model }: TypingIndicatorProps) {
  return (
    <Box className="px-4 py-2">
      <HStack space="sm" className="items-start">
        <Box className="h-6 w-6 items-center justify-center rounded-full bg-muted">
          <Text size="xs" className="text-foreground">S</Text>
        </Box>
        <VStack space="xs">
          {!!model && (
            <Text size="xs" className="text-muted-foreground">
              {model}
            </Text>
          )}
          <HStack space="xs" className="items-center">
            <Spinner size="small" className="text-muted-foreground" />
            <Text size="xs" className="text-muted-foreground">
              {loadingModel ? 'Loading model…' : 'Processing prompt…'}
            </Text>
            <LiveElapsed since={since} />
          </HStack>
        </VStack>
      </HStack>
    </Box>
  );
}
