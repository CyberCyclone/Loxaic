import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { PROMPT_SUGGESTIONS } from '@/lib/fixtures/conversations';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export function PromptSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const breakpoint = useBreakpoint();
  const columns = breakpoint === 'narrow' ? 1 : 2;

  return (
    <Box className="flex-1 items-center justify-center p-6">
      <VStack space="md" className="w-full max-w-[500px] items-center">
        <Heading size="lg" className="text-foreground">
          How can I help?
        </Heading>
        <Text className="text-center text-muted-foreground">
          Start a conversation, or try one of these:
        </Text>
        <HStack space="sm" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {PROMPT_SUGGESTIONS.map((s, i) => (
            <Pressable
              key={i}
              onPress={() => onPick(s.title)}
              className="rounded-md border border-border bg-card p-4 web:hover:bg-muted/30"
              style={{ width: columns === 1 ? '100%' : '48%' }}
            >
              <Text className="mb-1 font-semibold text-card-foreground">{s.title}</Text>
              <Text size="sm" className="text-muted-foreground">
                {s.desc}
              </Text>
            </Pressable>
          ))}
        </HStack>
      </VStack>
    </Box>
  );
}
