import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import type { AllocationDraft } from '@/lib/sandboxAllocation';

const FIELDS: { key: keyof AllocationDraft; label: string; keyboard: 'decimal-pad' | 'number-pad' }[] = [
  { key: 'memoryGb', label: 'Memory (GB)', keyboard: 'decimal-pad' },
  { key: 'cpus', label: 'CPUs', keyboard: 'decimal-pad' },
  { key: 'maxRunning', label: 'Running at once', keyboard: 'number-pad' },
];

/**
 * The three parts of a sandbox allocation (#254), as an admin types them:
 * the server-wide default on the Agent Sandbox screen, and one user's
 * override in Admin → Users. Each field's testID is `<prefix>.<field>`.
 */
export function AllocationFields({
  draft,
  onChange,
  testIDPrefix,
  placeholders,
  locked,
}: {
  draft: AllocationDraft;
  onChange: (next: AllocationDraft) => void;
  testIDPrefix: string;
  /** Shown in an empty field: the default it would follow. */
  placeholders?: Partial<AllocationDraft>;
  /** Fields that cannot be edited (all of them offline; the count while
   * SANDBOX_MAX_PER_USER pins it). */
  locked: Partial<Record<keyof AllocationDraft, boolean>>;
}) {
  return (
    <HStack space="sm" className="flex-wrap">
      {FIELDS.map((field) => (
        <VStack key={field.key} space="xs" className="min-w-24 flex-1">
          <Text size="xs" className="text-muted-foreground">
            {field.label}
          </Text>
          <Input className="h-10" isDisabled={locked[field.key] === true}>
            <InputField
              testID={`${testIDPrefix}.${field.key}`}
              value={draft[field.key]}
              {...(placeholders?.[field.key] ? { placeholder: placeholders[field.key] } : {})}
              onChangeText={(value) => { onChange({ ...draft, [field.key]: value }); }}
              keyboardType={field.keyboard}
            />
          </Input>
        </VStack>
      ))}
    </HStack>
  );
}
