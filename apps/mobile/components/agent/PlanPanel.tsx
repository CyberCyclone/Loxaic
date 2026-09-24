import { useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Check, ChevronDown, ClipboardList, Copy } from 'lucide-react-native';
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
import { ReviewSheet } from './ReviewSheet';

type WorkMode = 'manual' | 'auto';

const MODE_LABEL: Record<WorkMode, string> = { manual: 'Manual', auto: 'Auto' };

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
  /** What Accept runs the work in unless the menu says otherwise — the
   * Default mode from Settings. */
  defaultMode: WorkMode;
  /** The model Accept runs the work on, and a way to choose another. */
  executionModelName: string;
  onPickModel: () => void;
  onAccept: (mode: WorkMode) => void;
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
 * Nothing here talks to the server — every decision is a message the caller
 * sends — so the panel keeps no state beyond the suggestion being drafted and
 * whether the Accept menu is open.
 */
export function PlanPanel({
  plan,
  hidden = false,
  status,
  blockedReason,
  defaultMode,
  executionModelName,
  onPickModel,
  onAccept,
  onSuggest,
  onReject,
  onClose,
}: PlanPanelProps) {
  // The suggestion being written, keyed to the plan it is about: it survives
  // closing the panel and reopening it on the same plan, and a different plan
  // never sees it — a half-typed suggestion about the last plan must not be
  // sent against this one.
  const [suggestion, setSuggestion] = useState<{ callId: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // The tick goes back to the copy icon after a moment, as CodeBlock's does,
  // so a second copy shows feedback too.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const [acceptMenu, setAcceptMenu] = useState(false);

  const callId = plan?.callId ?? null;
  const mine = suggestion?.callId === callId ? suggestion : null;
  const suggesting = mine !== null;
  const draft = mine?.text ?? '';
  const setDraft = (text: string) => {
    if (callId !== null) setSuggestion({ callId, text });
  };

  // Transient, so reset whenever the panel closes or shows another plan.
  useEffect(() => {
    setCopied(false);
    setAcceptMenu(false);
  }, [callId]);

  const open = status === 'pending' || status === 'changes';
  const canDecide = open && blockedReason === null;

  const sendSuggestion = () => {
    const text = draft.trim();
    if (!text) return;
    onSuggest(text);
    setSuggestion(null);
  };

  return (
    <ReviewSheet
      open={plan !== null && !hidden}
      onClose={onClose}
      testIDBase="agent.plan"
      icon={ClipboardList}
      eyebrow="Proposed plan"
      title={plan?.title ?? ''}
      headerActions={
        <Pressable
          testID="agent.plan.copy"
          accessibilityLabel="Copy plan"
          onPress={() => {
            if (!plan) return;
            // A refused copy (web: the page not focused, or not a secure
            // context) keeps the copy icon rather than rejecting unhandled.
            // No toast: on native it would render under the sheet.
            void Clipboard.setStringAsync(plan.text)
              .then(() => {
                setCopied(true);
                if (copiedTimer.current) clearTimeout(copiedTimer.current);
                copiedTimer.current = setTimeout(() => { setCopied(false); }, 1500);
              })
              .catch(() => undefined);
          }}
          className="rounded-sm p-1.5 web:hover:bg-muted/50"
        >
          <Icon as={copied ? Check : Copy} size="sm" className="text-muted-foreground" />
        </Pressable>
      }
      footer={
        !canDecide ? (
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
              <Button testID="agent.plan.suggestion.back" variant="outline" size="sm" onPress={() => { setSuggestion(null); }}>
                <ButtonText>Back</ButtonText>
              </Button>
              <Button testID="agent.plan.suggestion.send" size="sm" isDisabled={draft.trim() === ''} onPress={sendSuggestion}>
                <ButtonText>Send suggestion</ButtonText>
              </Button>
            </HStack>
          </VStack>
        ) : (
          <VStack space="sm">
            {/* The work may run on a different model from the planning — a
                large model to plan, a fast one to execute, or the other way
                round. Shown before Accept, never changed silently. */}
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
            {/* The Accept menu opens here, in the sheet, not as a floating
                menu: a second native overlay over the sheet is what left the
                sheet stranded on iOS when the model list opened over it. */}
            {acceptMenu && (
              <VStack testID="agent.plan.accept.menu" className="self-end overflow-hidden rounded-md border border-border bg-card">
                {(['manual', 'auto'] as const).map((m) => (
                  <Pressable
                    key={m}
                    testID={`agent.plan.accept.${m}`}
                    onPress={() => {
                      setAcceptMenu(false);
                      onAccept(m);
                    }}
                    className="px-4 py-2.5 web:hover:bg-muted/50"
                  >
                    <Text size="sm" className="text-foreground">
                      {`Accept · ${MODE_LABEL[m]}`}
                    </Text>
                    <Text size="2xs" className="text-muted-foreground">
                      {m === 'manual' ? 'Asks before each change' : 'Makes changes without asking'}
                    </Text>
                  </Pressable>
                ))}
              </VStack>
            )}
            <HStack space="sm" className="flex-wrap justify-end">
              <Button testID="agent.plan.reject" variant="outline" size="sm" onPress={onReject}>
                <ButtonText className="text-destructive">Reject</ButtonText>
              </Button>
              <Button testID="agent.plan.suggest" variant="outline" size="sm" onPress={() => { setDraft(''); }}>
                <ButtonText>Offer suggestion</ButtonText>
              </Button>
              {/* A split button: the main half accepts in the Default mode —
                  named on it, because accepting changes the mode — and the
                  chevron offers either explicitly. */}
              <HStack className="overflow-hidden rounded-md">
                <Button testID="agent.plan.accept" size="sm" className="rounded-none" onPress={() => { onAccept(defaultMode); }}>
                  <ButtonText>{`Accept · ${MODE_LABEL[defaultMode]}`}</ButtonText>
                </Button>
                <Button
                  testID="agent.plan.accept.more"
                  accessibilityLabel="Choose the mode to accept in"
                  size="sm"
                  className="rounded-none border-l border-primary-foreground/30 px-2"
                  onPress={() => { setAcceptMenu((v) => !v); }}
                >
                  <Icon as={ChevronDown} size="sm" className="text-primary-foreground" />
                </Button>
              </HStack>
            </HStack>
          </VStack>
        )
      }
    >
      {plan && <Markdown text={plan.text} />}
    </ReviewSheet>
  );
}
