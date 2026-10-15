import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { CustomImagesPolicy } from '@loxaic/api-client';
import { CUSTOM_IMAGE_POLICIES, describeCustomImagesPolicy } from '@/lib/customImages';

interface CustomImagesPickerProps {
  policy: CustomImagesPolicy;
  disabled: boolean;
  /** Why the server can't run custom images right now, when it can't. */
  blocked?: string;
  pinned: boolean;
  onSelect: (policy: CustomImagesPolicy) => void;
}

/** Who may run agent sandboxes in an image other than Loxaic's own (#253). */
export function CustomImagesPicker({ policy, disabled, blocked, pinned, onSelect }: CustomImagesPickerProps) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Custom images
      </Text>
      <HStack space="xs" className="flex-wrap">
        {CUSTOM_IMAGE_POLICIES.map((p) => (
          <Pressable
            key={p.value}
            testID={`sandbox.customImages.${p.value}`}
            aria-selected={policy === p.value}
            disabled={disabled}
            onPress={() => { onSelect(p.value); }}
            className={`rounded-full px-3 py-1.5 ${policy === p.value ? 'bg-primary/15' : 'bg-muted'} ${disabled ? 'opacity-40' : ''}`}
          >
            <Text size="sm" className={policy === p.value ? 'text-primary' : 'text-muted-foreground'}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </HStack>
      <Text testID="sandbox.customImages.summary" size="2xs" className="text-muted-foreground">
        {describeCustomImagesPolicy(policy)}
      </Text>
      {pinned && (
        <Text size="2xs" className="text-muted-foreground">
          Set by the SANDBOX_CUSTOM_IMAGES environment variable.
        </Text>
      )}
      {policy !== 'off' && blocked && (
        <Text testID="sandbox.customImages.blocked" size="2xs" className="text-destructive">
          {blocked}
        </Text>
      )}
    </VStack>
  );
}
