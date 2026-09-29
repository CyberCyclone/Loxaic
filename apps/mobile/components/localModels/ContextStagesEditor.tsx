import type { FitEstimate, LocalModel } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { PresetChips } from '@/components/settings/PresetChips';
import { FitBadge } from './FitBadge';
import { formatWindow } from '@/lib/contextStages';
import {
  describeFit,
  draftFactor,
  suggestStages,
  type StageDraft,
  type StagesDraft,
} from '@/lib/localModels';

const CACHE_CHOICES = [
  { value: '', label: 'Default', key: 'default' },
  { value: 'q8_0', label: 'q8_0', key: 'q8_0' },
  { value: 'q4_0', label: 'q4_0', key: 'q4_0' },
];

interface Props {
  draft: StagesDraft;
  onChange: (next: StagesDraft) => void;
  /** The standard stage's context: what the stages extend. */
  standard: number | null;
  meta: LocalModel['meta'];
  /** Each stage priced the way it would load, aligned with `draft.stages`. */
  fits: FitEstimate[];
  errors: (string | null)[];
}

/**
 * Extended context (YaRN) on the model settings sheet: the larger contexts a
 * model can be reloaded at, one at a time, when a conversation needs them.
 *
 * The admin picks the contexts; the YaRN factor follows (context ÷ trained
 * context, 1M ÷ 256K = 4). Each stage shows what it costs in memory — priced
 * from the model's own attention layout, so a long stage that cannot fit says
 * so here rather than at 3am when a conversation reaches it — and a long
 * stage usually wants a quantized cache to fit at all.
 */
export function ContextStagesEditor({ draft, onChange, standard, meta, fits, errors }: Props) {
  const set = (patch: Partial<StagesDraft>) => { onChange({ ...draft, ...patch }); };
  const setStage = (i: number, patch: Partial<StageDraft>) => {
    set({ stages: draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  };
  const suggestion = suggestStages(meta, standard);

  return (
    <VStack testID="localModels.stages" space="md">
      <VStack space="xs">
        <Text size="sm" className="font-medium text-foreground">Extended context (YaRN)</Text>
        <Text size="2xs" className="text-muted-foreground">
          Lets a conversation grow past the standard context by reloading the model at a larger one. It reloads the model for everyone using it, and YaRN slightly lowers quality on short prompts while it is on, so a new conversation starts back at standard.
        </Text>
        <PresetChips
          chips={[
            { value: false, label: 'Off', key: 'off' },
            { value: true, label: 'On', key: 'on' },
          ]}
          value={draft.enabled}
          onChoose={(enabled) => { set({ enabled }); }}
          testIDPrefix="localModels.stages.enabled"
        />
      </VStack>

      {draft.enabled && (
        <>
          <VStack space="xs">
            <Text size="sm" className="text-foreground">Who can change it</Text>
            <PresetChips
              chips={[
                { value: 'everyone' as const, label: 'Anyone using the model', key: 'everyone' },
                { value: 'admins' as const, label: 'Admins only', key: 'admins' },
              ]}
              value={draft.whoMayChange}
              onChoose={(whoMayChange) => { set({ whoMayChange }); }}
              testIDPrefix="localModels.stages.who"
            />
          </VStack>

          <VStack space="xs">
            <Text size="sm" className="text-foreground">When a conversation fills the context</Text>
            <PresetChips
              chips={[
                { value: 'compact' as const, label: 'Compact', key: 'compact' },
                { value: 'extend' as const, label: 'Extend automatically', key: 'extend' },
              ]}
              value={draft.whenFull}
              onChoose={(whenFull) => { set({ whenFull }); }}
              testIDPrefix="localModels.stages.whenFull"
            />
            <Text size="2xs" className="text-muted-foreground">
              {draft.whenFull === 'extend'
                ? 'The model moves up a stage by itself, after any reply in progress, without asking. It reloads for everyone using it, and compacts instead at the last stage or when the next one will not fit.'
                : 'The conversation is compacted, as it is today. People can still choose to extend it.'}
            </Text>
          </VStack>

          <VStack space="sm">
            <Text size="sm" className="text-foreground">Stages</Text>
            {draft.stages.map((stage, i) => {
              const factor = draftFactor(stage, meta);
              const fit = fits[i] as FitEstimate | undefined;
              const error = errors[i] as string | null | undefined;
              return (
                <VStack key={i} testID={`localModels.stage.${String(i)}`} space="xs" className="rounded-md border border-border p-2">
                  <HStack space="sm" className="items-center">
                    <Text size="xs" className="w-14 text-muted-foreground">{`Stage ${String(i + 1)}`}</Text>
                    <Input className="w-32">
                      <InputField
                        testID={`localModels.stage.${String(i)}.ctx`}
                        value={stage.ctx}
                        onChangeText={(ctx) => { setStage(i, { ctx }); }}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        placeholder="Tokens"
                      />
                    </Input>
                    <Text testID={`localModels.stage.${String(i)}.factor`} size="2xs" className="shrink text-muted-foreground">
                      {factor !== null && !error ? `${formatWindow(Number(stage.ctx))} · YaRN ${String(factor)}×` : ''}
                    </Text>
                    <Pressable
                      testID={`localModels.stage.${String(i)}.remove`}
                      onPress={() => { set({ stages: draft.stages.filter((_, j) => j !== i) }); }}
                      className="ml-auto rounded-md px-2 py-1 web:hover:bg-muted/50"
                    >
                      <Text size="xs" className="text-muted-foreground underline">Remove</Text>
                    </Pressable>
                  </HStack>
                  {error && (
                    <Text testID={`localModels.stage.${String(i)}.error`} size="2xs" className="text-destructive">{error}</Text>
                  )}
                  <HStack space="sm" className="items-center">
                    <Text size="2xs" className="w-14 text-muted-foreground">Cache</Text>
                    <PresetChips
                      chips={CACHE_CHOICES}
                      value={stage.cacheTypeK ?? ''}
                      onChoose={(v) => { setStage(i, { cacheTypeK: v || undefined, cacheTypeV: v || undefined }); }}
                      testIDPrefix={`localModels.stage.${String(i)}.cache`}
                    />
                  </HStack>
                  {fit && !error && (
                    <HStack space="sm" className="items-center">
                      <FitBadge label={fit.label} testID={`localModels.stage.${String(i)}.fit`} />
                      <Text testID={`localModels.stage.${String(i)}.fitText`} size="2xs" className="min-w-0 flex-1 text-muted-foreground">
                        {describeFit(fit)}
                      </Text>
                    </HStack>
                  )}
                </VStack>
              );
            })}
            <HStack space="sm" className="flex-wrap">
              {suggestion.length > 0 && (
                <Button
                  testID="localModels.stages.suggest"
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    set({ stages: suggestion.map((ctx) => ({ ctx: String(ctx) })) });
                  }}
                >
                  <ButtonText>{`Suggest stages (${suggestion.map((c) => formatWindow(c)).join(', ')})`}</ButtonText>
                </Button>
              )}
              <Button
                testID="localModels.stages.add"
                variant="outline"
                size="sm"
                onPress={() => {
                  const last = Number(draft.stages.at(-1)?.ctx ?? standard ?? 0);
                  set({ stages: [...draft.stages, { ctx: String(Math.round(((Number.isFinite(last) ? last : 0) * 1.5) / 1024) * 1024 || 8192) }] });
                }}
              >
                <ButtonText>Add stage</ButtonText>
              </Button>
            </HStack>
          </VStack>
        </>
      )}
    </VStack>
  );
}
