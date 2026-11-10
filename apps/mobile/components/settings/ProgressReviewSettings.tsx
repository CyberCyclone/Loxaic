import { useEffect, useRef, useState } from 'react';
import { MAX_PROGRESS_REVIEW_PROMPT_CHARS, type UserPrefs } from '@loxaic/api-client';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { VStack } from '@/components/ui/vstack';
import {
  followSavedPrompt,
  reviewPromptDraft,
  reviewPromptState,
  reviewPromptStateLine,
} from '@/lib/progressReview';
import { PROGRESS_CHECK_PRESETS_MS, PROGRESS_STEP_PRESETS } from '@/lib/waitSettings';
import { PresetChips, type Chip } from './PresetChips';
import { WaitTimeout } from './WaitTimeout';

type Save = (patch: Partial<UserPrefs>, onSettled?: (ok: boolean) => void) => void;

/**
 * The progress review: a second model call that looks at a long run every so
 * often and steers it, or tells it to answer, when it is stuck. It replaced
 * the step check-in and the loop check, and asks nobody anything.
 *
 * Each row hides itself when the server does not report its field.
 */
export function ProgressReviewSettings({ prefs, save, disabled }: { prefs: UserPrefs; save: Save; disabled: boolean }) {
  const on = prefs.progressReview !== false;
  // A server that predates the review has none of these.
  if (
    prefs.progressReview === undefined &&
    prefs.progressCheckMs === undefined &&
    prefs.progressCheckSteps === undefined &&
    prefs.progressReviewPrompt === undefined
  ) {
    return null;
  }
  return (
    <VStack testID="checkins.progressReview" space="md" className="border-t border-border pt-4">
      <Text size="sm" className="font-medium text-foreground">
        Progress review
      </Text>
      <Text size="xs" className="text-muted-foreground">
        Every so often a second model call reads a summary of a long run and decides whether it is
        still getting somewhere. A run that is stuck, or keeps going after it already has its answer,
        is told so; if the next check says the same, it is told to answer. Sub-agents are told to
        report back at the first. Nobody is asked to press anything.
      </Text>

      {prefs.progressReview !== undefined && (
        <HStack space="sm" className="items-center">
          <Switch
            testID="settings.progressReview.toggle"
            value={on}
            onValueChange={(value) => { save({ progressReview: value }); }}
            isDisabled={disabled}
          />
          <Text size="sm" className="flex-1 text-foreground">
            {on ? 'Review long runs' : 'Off: nothing stops a run but you'}
          </Text>
        </HStack>
      )}

      {prefs.progressCheckMs !== undefined && (
        <WaitTimeout
          label="Check at least every"
          help="Working time. Waiting for your approval or for a turn on the model does not count."
          value={prefs.progressCheckMs}
          serverDefaultMs={prefs.serverDefaults?.progressCheckMs}
          onChoose={(v) => { save({ progressCheckMs: v }); }}
          disabled={disabled || !on}
          testIDPrefix="settings.progressCheck"
          presetsMs={PROGRESS_CHECK_PRESETS_MS}
        />
      )}

      {prefs.progressCheckSteps !== undefined && (
        <ProgressSteps
          value={prefs.progressCheckSteps}
          serverDefault={prefs.serverDefaults?.progressCheckSteps}
          onChoose={(v) => { save({ progressCheckSteps: v }); }}
          disabled={disabled || !on}
        />
      )}

      {prefs.progressReviewPrompt !== undefined && (
        <ReviewPrompt
          saved={prefs.progressReviewPrompt}
          builtIn={prefs.serverDefaults?.progressReviewPrompt}
          save={save}
          disabled={disabled}
        />
      )}
    </VStack>
  );
}

function ProgressSteps({
  value,
  serverDefault,
  onChoose,
  disabled,
}: {
  value: number | null;
  serverDefault: number | undefined;
  onChoose: (value: number | null) => void;
  disabled: boolean;
}) {
  const presets: number[] = [...PROGRESS_STEP_PRESETS];
  // A value set some other way (the API) gets its own chip, so the row never
  // renders with nothing selected.
  if (value != null && !presets.includes(value)) presets.push(value);
  presets.sort((a, b) => a - b);
  const chips: Chip<number | null>[] = [
    {
      value: null,
      label: serverDefault != null ? `Server default (${String(serverDefault)})` : 'Server default',
      key: 'default',
    },
    ...presets.map((n) => ({ value: n, label: String(n), key: String(n) })),
  ];
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        or every N steps
      </Text>
      <PresetChips chips={chips} value={value} onChoose={onChoose} disabled={disabled} testIDPrefix="settings.progressSteps" />
      <Text size="2xs" className="text-muted-foreground">
        Whichever comes first. Steps catch a run going round quickly, where minutes would let hundreds pass.
      </Text>
    </VStack>
  );
}

function ReviewPrompt({
  saved,
  builtIn,
  save,
  disabled,
}: {
  saved: string | null;
  builtIn: string | undefined;
  save: Save;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(() => reviewPromptDraft(saved, builtIn));
  const [justSaved, setJustSaved] = useState(false);
  // What the last Save sent, for putting it back if the server refuses it.
  const sent = useRef<string | null>(null);

  // Follows the server whenever nothing has been typed over it.
  useEffect(() => {
    setDraft((d) => followSavedPrompt(d, saved, builtIn));
  }, [saved, builtIn]);

  const state = reviewPromptState(draft, MAX_PROGRESS_REVIEW_PROMPT_CHARS);
  const line = reviewPromptStateLine(state, justSaved, MAX_PROGRESS_REVIEW_PROMPT_CHARS);
  const settled = (ok: boolean) => {
    if (ok) {
      setJustSaved(true);
      return;
    }
    // The screen has been put back to the old value. Keep what was typed,
    // still unsaved, rather than losing it to the rollback: a baseline it
    // cannot equal (it is never blank) stops the follow below replacing it,
    // and the follow then sets the real baseline.
    const typed = sent.current;
    if (typed !== null) setDraft({ text: typed, baseline: '' });
  };

  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Reviewer instructions
      </Text>
      <Textarea size="md" className="border-border bg-card">
        <TextareaInput
          testID="settings.reviewPrompt.input"
          value={draft.text}
          onChangeText={(text) => {
            setJustSaved(false);
            setDraft((d) => ({ ...d, text }));
          }}
          multiline
          editable={!disabled}
          style={{ minHeight: 120, maxHeight: 280 }}
        />
      </Textarea>
      <Text size="2xs" className="text-muted-foreground">
        The reviewer always gets a summary of the run and is told how to answer; these are the instructions in between.
      </Text>
      <HStack space="sm" className="items-center">
        <Text testID="settings.reviewPrompt.state" size="2xs" className="min-w-0 flex-1 text-muted-foreground">
          {line ?? ''}
        </Text>
        <Button
          testID="settings.reviewPrompt.reset"
          variant="outline"
          size="sm"
          className="shrink-0"
          isDisabled={disabled || saved === null}
          onPress={() => {
            sent.current = null;
            setJustSaved(false);
            // Reset is a choice, so whatever was typed goes with it.
            setDraft((d) => ({ ...d, text: d.baseline }));
            save({ progressReviewPrompt: null }, (ok) => { if (ok) setJustSaved(true); });
          }}
        >
          <ButtonText>Reset to default</ButtonText>
        </Button>
        <Button
          testID="settings.reviewPrompt.save"
          size="sm"
          className="shrink-0"
          isDisabled={disabled || state !== 'unsaved'}
          onPress={() => {
            sent.current = draft.text;
            setJustSaved(false);
            save({ progressReviewPrompt: draft.text }, settled);
          }}
        >
          <ButtonText>Save</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
