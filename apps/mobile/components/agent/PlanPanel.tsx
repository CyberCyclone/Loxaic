import { useEffect, useState } from 'react';
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, ClipboardList, Copy, X } from 'lucide-react-native';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
} from '@/components/ui/actionsheet';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { VStack } from '@/components/ui/vstack';
import { Markdown } from '@/components/markdown/Markdown';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { PlanStatus, ProposedPlan } from '@/lib/plan';

interface PlanPanelProps {
  /** The plan shown, or null for closed. */
  plan: ProposedPlan | null;
  /** Closed for a moment with the plan kept — while the model list has the
   * screen — so the sheet leaves showing its plan rather than going blank. */
  hidden?: boolean;
  status: PlanStatus | null;
  /**
   * Why the decision buttons are not offered, when they are not: a viewer, an
   * offline client, a run still going. Null means this person can decide now —
   * provided the plan is still open, which the panel reads from `status`.
   */
  blockedReason: string | null;
  /** The mode Accept runs the work in, as the button names it. */
  acceptModeLabel: string;
  /** The model Accept runs the work on, and a way to choose another. */
  executionModelName: string;
  onPickModel: () => void;
  onAccept: () => void;
  onSuggest: (text: string) => void;
  onReject: () => void;
  onClose: () => void;
}

/** Passive on purpose: on a shared conversation the person who decided may
 * not be the person reading. */
const SETTLED: Record<Exclude<PlanStatus, 'pending' | 'changes'>, string> = {
  accepted: 'This plan was accepted.',
  rejected: 'This plan was rejected.',
  superseded: 'A newer plan replaced this one — the newest is the one to decide on.',
};

/**
 * A proposed plan, full height, with the decision at its foot (#199).
 *
 * A sheet rather than a dialog because the plan is the whole of what is being
 * decided: it gets the screen, scrolls on its own, and stays readable while a
 * suggestion is typed beneath it. Nothing here talks to the server — every
 * decision is a message the caller sends — so the panel keeps no state beyond
 * the suggestion being drafted.
 */
export function PlanPanel({
  plan,
  hidden = false,
  status,
  blockedReason,
  acceptModeLabel,
  executionModelName,
  onPickModel,
  onAccept,
  onSuggest,
  onReject,
  onClose,
}: PlanPanelProps) {
  const [suggesting, setSuggesting] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 92% of the window, but never into the status bar or the notch: the sheet
  // adds its own bottom safe-area padding below this, and its top must clear
  // the top inset with a sliver of backdrop left to show it is a sheet.
  const sheetHeight = Math.round(Math.min(windowHeight * 0.92, windowHeight - insets.top - insets.bottom - 16));
  const keyboardHeight = useKeyboardHeight();

  // A different plan is a different question: a half-typed suggestion about
  // the last one must not be sent against this one.
  const callId = plan?.callId;
  useEffect(() => {
    setSuggesting(false);
    setDraft('');
    setCopied(false);
  }, [callId]);

  const open = status === 'pending' || status === 'changes';
  const canDecide = open && blockedReason === null;

  const sendSuggestion = () => {
    const text = draft.trim();
    if (!text) return;
    onSuggest(text);
    setDraft('');
    setSuggesting(false);
  };

  return (
    <Actionsheet isOpen={plan !== null && !hidden} onClose={onClose}>
      <ActionsheetBackdrop />
      {/* Selectable, unlike the base style's `web:select-none`, which suits a
          menu rather than a document someone may want to quote back. The
          base's 80vh cap is lifted; the height is set on the view inside. */}
      <ActionsheetContent testID="agent.plan.panel" className="max-h-full px-0 pt-0 web:select-text">
        {/* Full height comes from here, not from a class on the sheet: on
            native the sheet sets `height: undefined` after the caller's
            styles (it sizes itself to its content unless given snapPoints),
            so an `h-[92%]` class was erased there and the plan pushed the
            footer off the screen — while web, which keeps the class, looked
            fine. snapPoints read the window height once, at module load, so a
            resized browser would keep the old one; useWindowDimensions does
            not. It also keeps the footer above the keyboard: the overlay is
            out of reach of the screen's KeyboardAvoidingView, and one of its
            own measured the sheet wrongly (the sheet is placed by a
            transform), leaving the suggestion box under the keyboard on
            Android. */}
        <View
          style={{
            height: sheetHeight,
            width: '100%',
            // The keyboard lifts the footer rather than covering it; the plan
            // body gives up the height. On iOS the keyboard's height includes
            // the home-indicator inset the sheet already pads for; Android's
            // reported height stops short of the navigation bar, so it is
            // taken whole there (subtracting clipped the buttons by the inset).
            paddingBottom: Math.max(0, keyboardHeight - (Platform.OS === 'ios' ? insets.bottom : 0)),
          }}
        >
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          <HStack space="sm" className="min-w-0 items-center border-b border-border px-4 pb-3">
            <Icon as={ClipboardList} size="sm" className="text-primary" />
            <VStack className="min-w-0 flex-1">
              <Text size="2xs" className="uppercase text-muted-foreground">
                Proposed plan
              </Text>
              <Text size="sm" className="font-semibold text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                {plan?.title ?? ''}
              </Text>
            </VStack>
            <Pressable
              testID="agent.plan.copy"
              accessibilityLabel="Copy plan"
              onPress={() => {
                if (!plan) return;
                void Clipboard.setStringAsync(plan.text).then(() => { setCopied(true); });
              }}
              className="rounded-sm p-1.5 web:hover:bg-muted/50"
            >
              <Icon as={copied ? Check : Copy} size="sm" className="text-muted-foreground" />
            </Pressable>
            <Pressable
              testID="agent.plan.close"
              accessibilityLabel="Close plan"
              onPress={onClose}
              className="rounded-sm p-1.5 web:hover:bg-muted/50"
            >
              <Icon as={X} size="sm" className="text-muted-foreground" />
            </Pressable>
          </HStack>

          {/* flex:1 + minHeight:0, the Inspector's pattern: gluestack's
              min-h-0 on every Box lets a flex column compress its children
              into each other instead of overflowing, so the body has to be
              the thing that scrolls — and the footer stays outside it. */}
          <ScrollView testID="agent.plan.body" style={{ flex: 1, minHeight: 0, width: '100%' }} contentContainerStyle={{ padding: 16 }}>
            {plan && <Markdown text={plan.text} />}
          </ScrollView>

          <Box className="border-t border-border px-4 pb-4 pt-3">
            {!canDecide ? (
              <Text testID="agent.plan.status" size="xs" className="text-muted-foreground">
                {status && !open ? SETTLED[status] : (blockedReason ?? '')}
              </Text>
            ) : suggesting ? (
              <VStack space="sm">
                <Text size="xs" className="text-muted-foreground">
                  What should change? The agent revises the plan and proposes it again.
                </Text>
                <Textarea size="md" className="border-border bg-card">
                  <TextareaInput
                    testID="agent.plan.suggestion.input"
                    placeholder="e.g. Add a step that runs the tests before committing"
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    autoFocus
                    style={{ minHeight: 72, maxHeight: 160 }}
                  />
                </Textarea>
                <HStack space="sm" className="justify-end">
                  <Button testID="agent.plan.suggestion.back" variant="outline" size="sm" onPress={() => { setSuggesting(false); }}>
                    <ButtonText>Back</ButtonText>
                  </Button>
                  <Button testID="agent.plan.suggestion.send" size="sm" isDisabled={draft.trim() === ''} onPress={sendSuggestion}>
                    <ButtonText>Send suggestion</ButtonText>
                  </Button>
                </HStack>
              </VStack>
            ) : (
              <VStack space="sm">
                {/* The work may run on a different model from the planning —
                    a large model to plan, a fast one to execute, or the other
                    way round. Shown before Accept, never changed silently. */}
                <Pressable
                  testID="agent.plan.model"
                  onPress={onPickModel}
                  className="min-w-0 flex-row items-center gap-1.5 self-start rounded-md bg-muted px-2.5 py-1.5 web:hover:bg-muted/80"
                >
                  <Text size="xs" className="shrink-0 text-muted-foreground">
                    Run with
                  </Text>
                  <Text size="xs" className="min-w-0 shrink font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                    {executionModelName}
                  </Text>
                  <Icon as={ChevronDown} size="xs" className="text-muted-foreground" />
                </Pressable>
                <HStack space="sm" className="flex-wrap justify-end">
                  <Button testID="agent.plan.reject" variant="outline" size="sm" onPress={onReject}>
                    <ButtonText className="text-destructive">Reject</ButtonText>
                  </Button>
                  <Button testID="agent.plan.suggest" variant="outline" size="sm" onPress={() => { setSuggesting(true); }}>
                    <ButtonText>Offer suggestion</ButtonText>
                  </Button>
                  {/* The mode is on the button because accepting changes it,
                      which is otherwise only ever done by the selector. */}
                  <Button testID="agent.plan.accept" size="sm" onPress={onAccept}>
                    <ButtonText>{`Accept · ${acceptModeLabel}`}</ButtonText>
                  </Button>
                </HStack>
              </VStack>
            )}
          </Box>
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
