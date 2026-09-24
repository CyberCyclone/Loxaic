import { useEffect, useState } from 'react';
import { CheckSquare, Circle, CircleDot, MessageCircleQuestion, Square } from 'lucide-react-native';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Textarea, TextareaInput } from '@/components/ui/textarea';
import { VStack } from '@/components/ui/vstack';
import { isAnswered, type Answer, type ProposedQuestions, type Question, type QuestionsStatus } from '@/lib/plan';
import { ReviewSheet } from './ReviewSheet';

interface QuestionsPanelProps {
  /** The questions shown, or null for closed. */
  questions: ProposedQuestions | null;
  status: QuestionsStatus | null;
  /** Why answering is not offered right now, or null when it is — the same
   * reasons as the plan panel's. */
  blockedReason: string | null;
  onSubmit: (answers: Answer[]) => void;
  onClose: () => void;
}

/** One question's state in the panel: an Answer, plus whether "Other" is the
 * chosen (single-select) or ticked (multi-select) row. */
interface Draft extends Answer {
  otherOn: boolean;
}

const empty = (): Draft => ({ selected: [], other: '', otherOn: false });

/** What the panel hands back: "Other" counts only while it is chosen. */
function toAnswer(d: Draft): Answer {
  return { selected: d.selected, other: d.otherOn ? d.other : '' };
}

/**
 * Questions the agent needs answered before it can plan well (#199), one at a
 * time — "Question 1 of 3" — each with its options and a place to write
 * another answer, the way Claude asks.
 *
 * Nothing here talks to the server: Submit hands the answers to the caller,
 * which sends them as one message (formatAnswers) in planning mode.
 */
export function QuestionsPanel({ questions, status, blockedReason, onSubmit, onClose }: QuestionsPanelProps) {
  const list = questions?.questions ?? [];
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // A different set of questions starts from the first, with nothing chosen.
  const callId = questions?.callId;
  useEffect(() => {
    setStep(0);
    setDrafts([]);
  }, [callId]);

  const canAnswer = status === 'pending' && blockedReason === null;
  const q = list[Math.min(step, list.length - 1)] as Question | undefined;
  const draft = drafts[step] ?? empty();
  const answered = (i: number) => isAnswered(toAnswer(drafts[i] ?? empty()));
  const last = step >= list.length - 1;

  const update = (next: Draft) => {
    setDrafts((prev) => {
      const copy = [...prev];
      copy[step] = next;
      return copy;
    });
  };

  const choose = (i: number) => {
    if (!q) return;
    if (q.multiSelect) {
      const on = draft.selected.includes(i);
      update({ ...draft, selected: on ? draft.selected.filter((n) => n !== i) : [...draft.selected, i].sort((a, b) => a - b) });
    } else {
      // One answer: an option replaces "Other", as "Other" replaces an option.
      update({ ...draft, selected: [i], otherOn: false });
    }
  };

  const chooseOther = () => {
    update(q?.multiSelect ? { ...draft, otherOn: !draft.otherOn } : { ...draft, selected: [], otherOn: true });
  };

  return (
    <ReviewSheet
      open={questions !== null}
      onClose={onClose}
      testIDBase="agent.questions"
      icon={MessageCircleQuestion}
      eyebrow={canAnswer && list.length > 1 ? `Question ${String(step + 1)} of ${String(list.length)}` : 'Questions'}
      title={canAnswer ? (q?.header ?? 'Before I plan') : (questions?.title ?? '')}
      footer={
        !canAnswer ? (
          <Text testID="agent.questions.status" size="xs" className="text-muted-foreground">
            {status === 'answered' ? 'These questions were answered.' : (blockedReason ?? '')}
          </Text>
        ) : (
          <HStack space="sm" className="justify-end">
            <Button
              testID="agent.questions.back"
              variant="outline"
              size="sm"
              isDisabled={step === 0}
              onPress={() => { setStep((s) => Math.max(0, s - 1)); }}
            >
              <ButtonText>Back</ButtonText>
            </Button>
            {last ? (
              <Button
                testID="agent.questions.submit"
                size="sm"
                isDisabled={!list.every((_, i) => answered(i))}
                onPress={() => { onSubmit(list.map((_, i) => toAnswer(drafts[i] ?? empty()))); }}
              >
                <ButtonText>Submit answers</ButtonText>
              </Button>
            ) : (
              <Button
                testID="agent.questions.next"
                size="sm"
                isDisabled={!answered(step)}
                onPress={() => { setStep((s) => Math.min(list.length - 1, s + 1)); }}
              >
                <ButtonText>Next</ButtonText>
              </Button>
            )}
          </HStack>
        )
      }
    >
      {canAnswer && q ? (
        <VStack space="md">
          <Text testID="agent.questions.question" size="lg" className="font-medium text-foreground">
            {q.question}
          </Text>
          {q.multiSelect && (
            <Text size="xs" className="text-muted-foreground">
              Choose any that apply.
            </Text>
          )}
          <VStack space="sm">
            {q.options.map((o, i) => {
              const on = draft.selected.includes(i);
              return (
                <Pressable
                  key={i}
                  testID={`agent.questions.option.${String(step)}.${String(i)}`}
                  onPress={() => { choose(i); }}
                  className={`flex-row items-start gap-3 rounded-md border px-3 py-2.5 ${on ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
                >
                  <Icon
                    as={q.multiSelect ? (on ? CheckSquare : Square) : on ? CircleDot : Circle}
                    size="sm"
                    className={on ? 'text-primary' : 'text-muted-foreground'}
                  />
                  <VStack className="min-w-0 flex-1">
                    <Text size="sm" className="text-foreground">
                      {o.label}
                    </Text>
                    {o.description && (
                      <Text size="xs" className="text-muted-foreground">
                        {o.description}
                      </Text>
                    )}
                  </VStack>
                </Pressable>
              );
            })}
            <Pressable
              testID={`agent.questions.other.${String(step)}`}
              onPress={chooseOther}
              className={`flex-row items-start gap-3 rounded-md border px-3 py-2.5 ${draft.otherOn ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
            >
              <Icon
                as={q.multiSelect ? (draft.otherOn ? CheckSquare : Square) : draft.otherOn ? CircleDot : Circle}
                size="sm"
                className={draft.otherOn ? 'text-primary' : 'text-muted-foreground'}
              />
              <Text size="sm" className="text-foreground">
                Other — write your own answer
              </Text>
            </Pressable>
            {draft.otherOn && (
              <Textarea size="md" className="border-border bg-card">
                <TextareaInput
                  testID={`agent.questions.otherText.${String(step)}`}
                  placeholder="Your answer"
                  value={draft.other}
                  onChangeText={(text) => { update({ ...draft, other: text }); }}
                  multiline
                  autoFocus
                  style={{ minHeight: 64, maxHeight: 140 }}
                />
              </Textarea>
            )}
          </VStack>
        </VStack>
      ) : (
        // Read-only: every question and its options, for reading back what was
        // asked. The answers themselves are the message after it.
        <VStack space="lg">
          {list.map((item, i) => (
            <VStack key={i} space="xs">
              <Text size="sm" className="font-medium text-foreground">
                {`${String(i + 1)}. ${item.question}`}
              </Text>
              {item.options.map((o, j) => (
                <Text key={j} size="xs" className="text-muted-foreground">
                  {`• ${o.label}${o.description ? ` — ${o.description}` : ''}`}
                </Text>
              ))}
            </VStack>
          ))}
        </VStack>
      )}
    </ReviewSheet>
  );
}
