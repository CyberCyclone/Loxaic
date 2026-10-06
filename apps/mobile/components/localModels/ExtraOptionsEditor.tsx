import type { LlamaOptionInfo } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MAX_ROWS, optionFor, rowHint, type OptionRow } from '@/lib/extraOptions';

interface Props {
  /** `model` on a model's settings sheet, `router` on the runtime card. */
  scope: 'model' | 'router';
  rows: OptionRow[];
  onChange: (rows: OptionRow[]) => void;
  /** What the running build lists, or null when it is not known. */
  options: LlamaOptionInfo[] | null;
  /** Why options cannot be set right now, or null. */
  unavailable: string | null;
  /** What is wrong with each row (`rowProblems`), aligned with `rows`. */
  problems: (string | null)[];
  /** Stored keys the build running now does not accept, so are not passed. */
  skipped: string[];
  disabled?: boolean;
}

/**
 * Options passed to llama.cpp as typed, one `key = value` row each, with a
 * button for another row. For whatever llama.cpp (or a fork) offers that the
 * settings above do not.
 *
 * Each key is checked against the running build's own `--help` as it is
 * typed, and again by the server: one key llama.cpp does not know would stop
 * it from starting at all.
 */
export function ExtraOptionsEditor({ scope, rows, onChange, options, unavailable, problems, skipped, disabled }: Props) {
  const id = `localModels.extraOptions.${scope}`;
  const set = (i: number, patch: Partial<OptionRow>) => {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  // Nothing can be checked, so nothing new can be added; existing rows can
  // still be removed.
  const locked = Boolean(disabled) || options === null;

  return (
    <VStack testID={id} space="sm">
      <VStack space="xs">
        <Text size="sm" className="font-medium text-foreground">
          {scope === 'model' ? 'Extra llama.cpp options' : 'Extra llama.cpp options for every model'}
        </Text>
        <Text size="2xs" className="text-muted-foreground">
          {scope === 'model'
            ? 'Passed to llama.cpp as typed, for options the settings above do not cover. A name is an option from llama-server --help without its dashes (keep, cache-reuse), and a switch takes true or false. These win over the same option set for every model.'
            : 'Passed to llama.cpp for every model, as typed. A model\'s own options win over these. Saving restarts the runtime, which unloads every model; pinned ones come back.'}
        </Text>
        <Text size="2xs" className="text-muted-foreground">
          Each name is checked against this llama.cpp build&apos;s own list. Other versions may not support an option, and a value llama.cpp cannot read makes the model fail to load, with its reason.
        </Text>
      </VStack>

      {unavailable && (
        <Text testID={`${id}.unavailable`} size="2xs" className="text-warning">
          {unavailable}
        </Text>
      )}
      {skipped.length > 0 && (
        <Text testID={`${id}.skipped`} size="2xs" className="text-warning">
          {`Not passed: this llama.cpp version doesn't know ${skipped.map((k) => `"${k}"`).join(', ')}. ${skipped.length === 1 ? 'It is' : 'They are'} kept, and passed again under a version that does.`}
        </Text>
      )}

      {rows.map((row, i) => {
        const problem = problems[i] ?? null;
        const hint = problem ? null : rowHint(row, options);
        const option = optionFor(row.key, options);
        return (
          <VStack key={i} testID={`${id}.${String(i)}`} space="xs">
            <HStack space="sm" className="items-center">
              <Input className="min-w-0 flex-1" isDisabled={disabled}>
                <InputField
                  testID={`${id}.${String(i)}.key`}
                  value={row.key}
                  onChangeText={(key) => { set(i, { key }); }}
                  placeholder="Option"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </Input>
              <Text size="sm" className="text-muted-foreground">=</Text>
              <Input className="min-w-0 flex-1" isDisabled={disabled}>
                <InputField
                  testID={`${id}.${String(i)}.value`}
                  value={row.value}
                  onChangeText={(value) => { set(i, { value }); }}
                  placeholder={option && !option.takesValue ? 'true or false' : 'Value'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </Input>
              <Pressable
                testID={`${id}.${String(i)}.remove`}
                disabled={disabled}
                onPress={() => { onChange(rows.filter((_, j) => j !== i)); }}
                className="shrink-0 rounded-md px-2 py-1 web:hover:bg-muted/50"
              >
                <Text size="xs" className="text-muted-foreground underline">Remove</Text>
              </Pressable>
            </HStack>
            {problem ? (
              <Text testID={`${id}.${String(i)}.error`} size="2xs" className="text-destructive">
                {problem}
              </Text>
            ) : hint ? (
              <Text testID={`${id}.${String(i)}.hint`} size="2xs" className="text-muted-foreground">
                {hint}
              </Text>
            ) : null}
          </VStack>
        );
      })}

      <HStack>
        <Button
          testID={`${id}.add`}
          variant="outline"
          size="sm"
          isDisabled={locked || rows.length >= MAX_ROWS}
          onPress={() => { onChange([...rows, { key: '', value: '' }]); }}
        >
          <ButtonText>Add option</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
