import { useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

export function ThinkingBlock({ text }: { text: string }) {
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
            Thinking...
          </Text>
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
