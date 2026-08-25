import { useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { LiveElapsed } from './LiveElapsed';

interface ThinkingBlockProps {
  text: string;
  /** True while reasoning tokens are still actively streaming in. */
  live?: boolean;
  /** Epoch ms the response started at — shown next to the spinner while live. */
  since?: number | null;
}

export function ThinkingBlock({ text, live, since }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
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
          {live && !!since && <LiveElapsed since={since} />}
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
