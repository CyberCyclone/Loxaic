import type { SubAgentModelMode } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import { PresetChips, type Chip } from './PresetChips';

const MODES: Chip<SubAgentModelMode>[] = [
  { value: 'choose', label: 'Agent’s model, or its pick', key: 'choose' },
  { value: 'parent', label: 'Always the agent’s model', key: 'parent' },
  { value: 'fixed', label: 'One model I choose', key: 'fixed' },
];

/** What each choice does, said under the chips — the three differ in cost,
 * and none of that is guessable from a label. */
const HELP: Record<SubAgentModelMode, string> = {
  choose:
    'A sub-agent runs on the model the agent itself is using, unless the agent picks another from the ones you have used recently. In a routine, which runs with nobody watching, it always uses the routine’s model.',
  parent:
    'A sub-agent always runs on the model the agent itself is using. Nothing new is loaded, and nothing is spent on a model you did not choose for that conversation.',
  fixed:
    'Every sub-agent runs on the model below, whatever the agent is using — in routines too. Useful for sending sub-agents to a smaller, faster model.',
};

/**
 * Which model a sub-agent runs on.
 *
 * Controlled by the screen's one `usePrefs`, like every row beside it. "One
 * model I choose" needs a model before it means anything, so choosing it with
 * none picked opens the model list instead of saving — the server refuses
 * `fixed` without one, and a chip that selected and then snapped back would
 * read as broken.
 */
export function SubAgentModel({
  mode,
  model,
  modelName,
  onChooseMode,
  onPickModel,
  disabled,
}: {
  mode: SubAgentModelMode;
  /** The fixed model's reference, or null when none was ever picked. */
  model: string | null;
  /** Its display name; null when there is none or it is no longer served. */
  modelName: string | null;
  onChooseMode: (mode: SubAgentModelMode) => void;
  onPickModel: () => void;
  disabled?: boolean;
}) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Model for sub-agents
      </Text>
      <PresetChips
        chips={MODES}
        value={mode}
        onChoose={(next) => {
          if (next === 'fixed' && !model) onPickModel();
          else onChooseMode(next);
        }}
        disabled={disabled}
        testIDPrefix="checkins.subagentModel"
      />
      {mode === 'fixed' && (
        <HStack space="sm" className="min-w-0 items-center">
          <Text
            testID="checkins.subagentModel.current"
            size="sm"
            className="min-w-0 shrink text-foreground"
            numberOfLines={1}
            style={TRUNCATE_TEXT}
          >
            {modelName ?? model ?? 'No model chosen'}
          </Text>
          <Pressable
            testID="checkins.subagentModel.pick"
            disabled={disabled}
            onPress={onPickModel}
            className={`shrink-0 rounded-md border border-border px-2.5 py-1 web:hover:bg-muted/50 ${disabled ? 'opacity-40' : ''}`}
          >
            <Text size="xs" className="text-foreground">
              Change
            </Text>
          </Pressable>
        </HStack>
      )}
      <Text testID="checkins.subagentModel.help" size="2xs" className="text-muted-foreground">
        {HELP[mode]}
      </Text>
      {mode !== 'parent' && (
        <Text size="2xs" className="text-muted-foreground">
          A sub-agent on a different model that runs on this server may make it unload the agent’s own model to
          make room; the agent’s model then loads again when it carries on, which takes time.
        </Text>
      )}
    </VStack>
  );
}
