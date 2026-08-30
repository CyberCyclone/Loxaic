import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';

interface NetworkToggleProps {
  mode: 'container' | 'host' | 'off';
  allowNetwork: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}

/** Host mode always has network access — the toggle is replaced with a
 * static line rather than shown disabled-but-checked, which would read as
 * "on because someone chose to turn it on" instead of "on because there's no
 * way to sandbox it here". */
export function NetworkToggle({ mode, allowNetwork, disabled, onChange }: NetworkToggleProps) {
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Network access
      </Text>
      {mode === 'host' ? (
        <Text size="sm" className="text-muted-foreground">
          Host sandboxes always have network access.
        </Text>
      ) : (
        <HStack space="sm" className="items-center">
          <Switch testID="sandbox.network.toggle" value={allowNetwork} onValueChange={onChange} isDisabled={disabled} />
          <Text size="sm" className="flex-1 text-foreground">
            Let sandboxes reach the network (needed to install dependencies)
          </Text>
        </HStack>
      )}
    </VStack>
  );
}
