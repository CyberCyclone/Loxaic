import { ScrollView } from 'react-native';
import type { PaletteSkill } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { clampLines } from '@/lib/truncate';

interface CommandPaletteProps {
  skills: PaletteSkill[];
  selectedIndex: number;
  onSelect: (skill: PaletteSkill) => void;
}

const CLAMP = clampLines(2);

/** Shown after the name for a skill that is not a built-in, so a person's own
 * (or a workspace's) can be told from the one it replaced. */
const SOURCE_LABEL: Partial<Record<PaletteSkill['source'], string>> = {
  user: 'yours',
  workspace: 'workspace',
};

/**
 * Docked above the composer's Textarea (the parent wraps both in a `relative`
 * Box; this is `absolute bottom-full`) while the user is typing a "/" skill
 * name: every skill on a bare "/", most-used first, narrowed as they type.
 *
 * Selecting a row — by tap, or Enter/Tab on web — only ever inserts
 * "/name " into the input, so the person can add instructions after it.
 * Nothing here sends on its own; that's the same insert-then-Send contract the
 * context ring's Compact button follows, so there's exactly one way anything
 * actually runs.
 *
 * Height-capped and scrolling: "every skill" can be many.
 */
export function CommandPalette({ skills, selectedIndex, onSelect }: CommandPaletteProps) {
  if (skills.length === 0) return null;

  return (
    <Box
      testID="composer.palette"
      className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-hidden rounded-md border border-border bg-popover shadow-md"
    >
      <ScrollView keyboardShouldPersistTaps="always">
        {skills.map((skill, i) => (
          <Pressable
            key={skill.name}
            testID={`composer.command.${skill.name}`}
            onPress={() => { onSelect(skill); }}
            className={`px-3 py-2 ${i === selectedIndex ? 'bg-muted' : ''}`}
          >
            <VStack space="xs">
              <HStack space="xs" className="items-baseline">
                <Text size="sm" className="font-medium text-foreground">
                  /{skill.name}
                </Text>
                {skill.argHint ? (
                  <Text size="xs" className="text-muted-foreground">
                    {skill.argHint}
                  </Text>
                ) : null}
                {SOURCE_LABEL[skill.source] ? (
                  <Text size="xs" className="text-muted-foreground">
                    · {SOURCE_LABEL[skill.source]}
                  </Text>
                ) : null}
              </HStack>
              <Text size="xs" className="text-muted-foreground" numberOfLines={2} style={CLAMP}>
                {skill.description}
              </Text>
            </VStack>
          </Pressable>
        ))}
      </ScrollView>
    </Box>
  );
}
