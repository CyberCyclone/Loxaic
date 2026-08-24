import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';

export function TypingIndicator() {
  return (
    <Box className="px-4 py-2">
      <HStack space="sm" className="items-center">
        <Box className="h-6 w-6 items-center justify-center rounded-full bg-muted">
          <Text size="xs" className="text-foreground">S</Text>
        </Box>
        <HStack space="xs" className="items-center">
          <Spinner size="small" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">Thinking…</Text>
        </HStack>
      </HStack>
    </Box>
  );
}
