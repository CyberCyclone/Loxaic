import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';

interface TypingIndicatorProps {
  /** True when the backend reported the target model isn't loaded yet (LM Studio JIT load). */
  loadingModel?: boolean;
}

// Shown only before *any* token (reasoning or answer) has streamed — once
// the model actually starts reasoning, that's real chain-of-thought and
// gets its own live ThinkingBlock instead of this generic label. So this
// window is genuinely prompt evaluation (prefill), not "thinking" — label
// it that way instead of overclaiming.
export function TypingIndicator({ loadingModel }: TypingIndicatorProps) {
  return (
    <Box className="px-4 py-2">
      <HStack space="sm" className="items-center">
        <Box className="h-6 w-6 items-center justify-center rounded-full bg-muted">
          <Text size="xs" className="text-foreground">S</Text>
        </Box>
        <HStack space="xs" className="items-center">
          <Spinner size="small" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">
            {loadingModel ? 'Loading model…' : 'Processing prompt…'}
          </Text>
        </HStack>
      </HStack>
    </Box>
  );
}
