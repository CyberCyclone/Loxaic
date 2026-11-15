import type { ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface ThreadCardProps {
  /** e.g. `subagent.card.<callId>`: the card is `<base>`, its press target
   * `<base>.open`, its chevron `<base>.chevron`. */
  testIDBase: string;
  /** The title's own testID: an assertion anchor on the Text, since XCUITest
   * does not expose the card's container view. */
  titleTestID: string;
  icon: LucideIcon;
  title: string;
  /** What pressing the card does, for a screen reader. */
  openLabel: string;
  onOpen: () => void;
  /** The line under the title: how it is going. */
  children: ReactNode;
  /** A control of the card's own (a sub-agent's Stop), between the body and
   * the chevron. A sibling of the press target, never inside it: a button
   * nested in the card's own pressable would open the panel as it acted. */
  action?: ReactNode;
}

/**
 * Something that happened beside the thread's own messages, as a card in the
 * transcript where it happened, opening a panel with the whole of it: a
 * sub-agent (`SubAgentCard`), a progress review (`RunReviewCard`).
 *
 * One component so the two read as the same kind of thing and share what the
 * sub-agent's card learnt on devices: separate pressables side by side, and
 * a title that truncates instead of pushing the chevron off the row.
 */
export function ThreadCard({ testIDBase, titleTestID, icon, title, openLabel, onOpen, children, action }: ThreadCardProps) {
  return (
    <Box testID={testIDBase} className="my-1.5 rounded-md border border-primary/30 bg-primary/5">
      <HStack className="min-w-0 items-stretch">
        <Pressable
          testID={`${testIDBase}.open`}
          accessibilityLabel={openLabel}
          onPress={onOpen}
          className="min-w-0 flex-1 px-3 py-2.5 web:hover:bg-primary/5"
        >
          <HStack space="sm" className="min-w-0 items-start">
            <Box className="pt-0.5">
              <Icon as={icon} size="sm" className="text-primary" />
            </Box>
            <VStack space="xs" className="min-w-0 flex-1">
              <Text testID={titleTestID} size="sm" className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {title}
              </Text>
              {children}
            </VStack>
          </HStack>
        </Pressable>
        {action}
        <Pressable
          testID={`${testIDBase}.chevron`}
          accessibilityLabel="Open"
          onPress={onOpen}
          className="shrink-0 items-center justify-center pl-1 pr-3 web:hover:bg-primary/10"
        >
          <Icon as={ChevronRight} size="sm" className="text-muted-foreground" />
        </Pressable>
      </HStack>
    </Box>
  );
}
