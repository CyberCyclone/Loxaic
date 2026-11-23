import { ArrowLeft, Menu as MenuIcon } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { useTitleBarInset } from '@/hooks/useTitleBarInset';
import { useOverlaySidebar } from './AppShell';

interface MainHeaderProps {
  title: string;
  subtitle?: string;
  /** Rendered on narrow/medium layouts to open the sidebar slide-over. */
  onOpenMenu?: () => void;
  /**
   * Takes the place of the menu button on a screen you arrived at from
   * another — a routine's chat, reached from the routines list. Both at once
   * would be two different ideas of "where does this go" in the same corner.
   */
  onBack?: () => void;
  backTestID?: string;
  right?: React.ReactNode;
}

export function MainHeader({ title, subtitle, onOpenMenu, onBack, backTestID, right }: MainHeaderProps) {
  const titleBarInset = useTitleBarInset();
  // With the sidebar a slide-over, this header starts at the window's left
  // edge, under the macOS window buttons in the desktop app.
  const overlaySidebar = useOverlaySidebar();
  const padLeft = titleBarInset && overlaySidebar ? titleBarInset : 0;
  return (
    <HStack
      testID="shell.header"
      className={`h-14 items-center justify-between border-b border-border bg-background px-4 ${titleBarInset ? 'web:app-drag' : ''}`}
      style={padLeft ? { paddingLeft: padLeft } : undefined}
    >
      {/* Both halves of the shrink fix, and both are needed. React Native
          defaults every view to `flexShrink: 0`, so a title as wide as its
          text pushed the buttons on the right off the edge of the header —
          reported from a phone, where a conversation is titled from its first
          message and is routinely longer than the bar. `min-w-0` is what lets
          a flex item shrink below its content at all; the `shrink-0` on the
          controls is what stops the space being won back from them. Same pair
          as WorkspacePill, for the same reason (see its comment). */}
      <HStack space="sm" className="min-w-0 flex-1 items-center">
        {onBack ? (
          <Pressable
            testID={backTestID ?? 'shell.backButton'}
            accessibilityLabel="Back"
            onPress={onBack}
            className="shrink-0 rounded-sm p-1.5 web:app-no-drag web:hover:bg-muted/50"
          >
            <Icon as={ArrowLeft} size="md" className="text-foreground" />
          </Pressable>
        ) : onOpenMenu ? (
          <Pressable
            testID="shell.menuButton"
            onPress={onOpenMenu}
            className="shrink-0 rounded-sm p-1.5 web:app-no-drag web:hover:bg-muted/50"
          >
            <Icon as={MenuIcon} size="md" className="text-foreground" />
          </Pressable>
        ) : null}
        <VStack className="min-w-0 flex-1">
          {/* Both mechanisms, because each covers a platform the other does
              not: numberOfLines is the real one on native, TRUNCATE_TEXT is
              the only one that works on web (see lib/truncate.ts). */}
          <Text
            testID="shell.header.title"
            className="font-semibold text-foreground"
            numberOfLines={1}
            style={TRUNCATE_TEXT}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text size="xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
              {subtitle}
            </Text>
          ) : null}
        </VStack>
      </HStack>
      {right ? <HStack className="shrink-0 items-center web:app-no-drag">{right}</HStack> : null}
    </HStack>
  );
}
