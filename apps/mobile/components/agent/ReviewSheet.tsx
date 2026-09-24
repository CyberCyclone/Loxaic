import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, type LucideIcon } from 'lucide-react-native';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
} from '@/components/ui/actionsheet';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface ReviewSheetProps {
  open: boolean;
  onClose: () => void;
  /** e.g. `agent.plan` — the sheet is `<id>.panel`, the body `<id>.body`,
   * the close button `<id>.close`. */
  testIDBase: string;
  icon: LucideIcon;
  /** The small line above the title: "Proposed plan", "Questions". */
  eyebrow: string;
  title: string;
  /** Extra header buttons, before the close button. */
  headerActions?: ReactNode;
  /** Scrolls; the footer does not. */
  children: ReactNode;
  footer: ReactNode;
}

/**
 * The full-height sheet a plan or a set of questions is reviewed in (#199).
 *
 * Shared because everything in it was learnt on devices, not on web, and a
 * second copy would have to learn it again:
 *
 * - **The height is set on a view inside, never by a class on the sheet.** On
 *   native the vendored sheet appends `height: snapPoints ? … : undefined`
 *   after the caller's styles, so an `h-[92%]` class was erased and the content
 *   pushed the footer off the screen, while web (which keeps the class) looked
 *   fine. snapPoints read the window height once, at module load, so a resized
 *   browser would keep the old one; useWindowDimensions does not.
 * - **The keyboard is padded for by hand.** The overlay is out of reach of the
 *   screen's KeyboardAvoidingView, and one inside mis-measures the sheet (it is
 *   placed by a transform), leaving a text box under the keyboard on Android.
 * - **Selectable text** — the base style's `web:select-none` suits a menu, not
 *   a document someone may want to quote back.
 */
export function ReviewSheet({
  open,
  onClose,
  testIDBase,
  icon,
  eyebrow,
  title,
  headerActions,
  children,
  footer,
}: ReviewSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 92% of the window, but never into the status bar or the notch: the sheet
  // adds its own bottom safe-area padding below this, and its top must clear
  // the top inset with a sliver of backdrop left to show it is a sheet.
  const sheetHeight = Math.round(Math.min(windowHeight * 0.92, windowHeight - insets.top - insets.bottom - 16));
  const keyboardHeight = useKeyboardHeight();

  return (
    <Actionsheet isOpen={open} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent testID={`${testIDBase}.panel`} className="max-h-full px-0 pt-0 web:select-text">
        <View
          style={{
            height: sheetHeight,
            width: '100%',
            // The keyboard lifts the footer rather than covering it; the body
            // gives up the height. On iOS the keyboard's height includes the
            // home-indicator inset the sheet already pads for; Android's stops
            // short of the navigation bar, so it is taken whole there
            // (subtracting it clipped the buttons by the inset).
            paddingBottom: Math.max(0, keyboardHeight - (Platform.OS === 'ios' ? insets.bottom : 0)),
          }}
        >
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          <HStack space="sm" className="min-w-0 items-center border-b border-border px-4 pb-3">
            <Icon as={icon} size="sm" className="text-primary" />
            <VStack className="min-w-0 flex-1">
              <Text size="2xs" className="uppercase text-muted-foreground">
                {eyebrow}
              </Text>
              <Text size="sm" className="font-semibold text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {title}
              </Text>
            </VStack>
            {headerActions}
            <Pressable
              testID={`${testIDBase}.close`}
              accessibilityLabel="Close"
              onPress={onClose}
              className="rounded-sm p-1.5 web:hover:bg-muted/50"
            >
              <Icon as={X} size="sm" className="text-muted-foreground" />
            </Pressable>
          </HStack>

          {/* flex:1 + minHeight:0, the Inspector's pattern: gluestack's min-h-0
              on every Box lets a flex column compress its children into each
              other instead of overflowing, so the body has to be the thing
              that scrolls — and the footer stays outside it. */}
          <ScrollView
            testID={`${testIDBase}.body`}
            style={{ flex: 1, minHeight: 0, width: '100%' }}
            contentContainerStyle={{ padding: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>

          <Box className="border-t border-border px-4 pb-4 pt-3">{footer}</Box>
        </View>
      </ActionsheetContent>
    </Actionsheet>
  );
}

/**
 * The on-screen keyboard's height, or 0 while it is hidden. Web never raises
 * these events, so it stays 0 there — a browser resizes the page instead.
 */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (e) => { setHeight(e.endCoordinates.height); });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { setHeight(0); });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
}
