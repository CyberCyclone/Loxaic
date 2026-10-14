import { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import type { PaletteSkill } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { scrollToShow } from '@/lib/skillPalette';
import { clampLines } from '@/lib/truncate';

interface CommandPaletteProps {
  skills: PaletteSkill[];
  /** The highlighted row, or -1 for none. */
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
  const scroller = useRef<ScrollView>(null);
  const rows = useRef<{ top: number; height: number }[]>([]);
  const view = useRef({ scrollY: 0, height: 0 });

  // The highlight moves with the arrow keys, and the list is taller than its
  // cap: a highlighted row out of view is one Enter would insert unseen.
  useEffect(() => {
    const row = selectedIndex < 0 ? undefined : rows.current.at(selectedIndex);
    if (!row) return;
    const y = scrollToShow(row, view.current);
    if (y !== null) scroller.current?.scrollTo({ y, animated: false });
  }, [selectedIndex]);

  if (skills.length === 0) return null;

  return (
    <Box
      testID="composer.palette"
      className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-hidden rounded-md border border-border bg-popover shadow-md"
    >
      <ScrollView
        ref={scroller}
        keyboardShouldPersistTaps="always"
        scrollEventThrottle={16}
        onScroll={(e) => { view.current.scrollY = e.nativeEvent.contentOffset.y; }}
        onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; }}
      >
        {skills.map((skill, i) => (
          <Pressable
            key={skill.name}
            testID={`composer.command.${skill.name}`}
            aria-selected={i === selectedIndex}
            onLayout={(e) => { rows.current[i] = { top: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height }; }}
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
