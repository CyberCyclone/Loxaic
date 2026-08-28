import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { SlashCommand } from '@/lib/types';

interface CommandPaletteProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
}

/**
 * Docked above the composer's Textarea (the parent wraps both in a `relative`
 * Box; this is `absolute bottom-full`) while the user is mid-way through
 * typing a "/" command name.
 *
 * Selecting a row — by tap, or Enter/Tab on web — only ever inserts the
 * command into the input. Nothing here sends on its own; that's the same
 * insert-then-Send contract the context ring's Compact button follows, so
 * there's exactly one way anything actually runs.
 */
export function CommandPalette({ commands, selectedIndex, onSelect }: CommandPaletteProps) {
  if (commands.length === 0) return null;

  return (
    <Box className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-hidden rounded-md border border-border bg-popover shadow-md">
      <ScrollView keyboardShouldPersistTaps="always">
        {commands.map((cmd, i) => (
          <Pressable
            key={cmd.name}
            onPress={() => { onSelect(cmd); }}
            className={`px-3 py-2 ${i === selectedIndex ? 'bg-muted' : ''}`}
          >
            <VStack space="xs">
              <HStack space="xs" className="items-baseline">
                <Text size="sm" className="font-medium text-foreground">
                  /{cmd.name}
                </Text>
                {cmd.argHint && (
                  <Text size="xs" className="text-muted-foreground">
                    {cmd.argHint}
                  </Text>
                )}
              </HStack>
              <Text size="xs" className="text-muted-foreground">
                {cmd.description}
              </Text>
            </VStack>
          </Pressable>
        ))}
      </ScrollView>
    </Box>
  );
}
