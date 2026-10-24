import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import type { PromptCacheBanner as Banner } from '@/lib/promptCache';

/**
 * Above the composer when a reload took this conversation's prompt cache: the
 * next message will re-read the whole conversation, which on a long one is
 * minutes — said before it is sent rather than discovered after. In the flow,
 * like the step check-in banner, and informational only: sending is still
 * the person's call.
 */
export function PromptCacheBanner({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  return (
    <HStack
      testID="chat.promptCache.banner"
      space="sm"
      className="items-center border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      <Text testID="chat.promptCache.banner.text" size="sm" className="min-w-0 shrink text-foreground">
        {banner.text}
      </Text>
      <Button testID="chat.promptCache.dismiss" size="sm" variant="outline" className="shrink-0" onPress={onDismiss}>
        <ButtonText>Dismiss</ButtonText>
      </Button>
    </HStack>
  );
}
