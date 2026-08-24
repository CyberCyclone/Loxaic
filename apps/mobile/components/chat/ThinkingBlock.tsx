import { useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';

interface ThinkingBlockProps {
  text: string;
  /** True while reasoning tokens are still actively streaming in. */
  live?: boolean;
}

export function ThinkingBlock({ text, live }: ThinkingBlockProps) {
  // Auto-expand for reasoning that's happening right now, so the streamed
  // text itself is the proof it's genuinely thinking rather than stalled —
  // the `live` value at mount time only, so it doesn't snap shut on the
  // user once the model moves on to the answer.
  const [open, setOpen] = useState(live ?? false);
  return (
    <Box className="my-1.5 rounded-md border border-border bg-card">
      <Pressable onPress={() => setOpen((o) => !o)}>
        <HStack className="items-center gap-1.5 px-3 py-2">
          <Icon
            as={ChevronRight}
            size="xs"
            className="text-muted-foreground"
            style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
          />
          <Text size="sm" className="text-muted-foreground">
            {live ? 'Thinking…' : 'Thought'}
          </Text>
          {live && <Spinner size="small" className="text-muted-foreground" />}
        </HStack>
      </Pressable>
      {open && (
        <Text size="sm" className="border-t border-border px-3 py-2 text-muted-foreground">
          {text}
        </Text>
      )}
    </Box>
  );
}
