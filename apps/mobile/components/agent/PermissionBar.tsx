import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.command === 'string') return args.command;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.pattern === 'string') return args.pattern;
  return tool;
}

interface PermissionBarProps {
  tool: string;
  args: Record<string, unknown>;
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionBar({ tool, args, onAllow, onDeny }: PermissionBarProps) {
  return (
    <VStack
      testID="agent.permission.bar"
      space="xs"
      className="border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      <Text size="sm" className="text-foreground">
        Agent wants to run <Text size="sm" className="font-mono text-warning">{tool}</Text>
        {' — '}
        <Text size="sm" className="font-mono text-muted-foreground">{summarizeArgs(tool, args)}</Text>
      </Text>
      <HStack space="sm" className="justify-end">
        <Button testID="agent.permission.deny" variant="outline" size="sm" onPress={onDeny}>
          <ButtonText>Deny</ButtonText>
        </Button>
        <Button testID="agent.permission.allow" size="sm" onPress={onAllow}>
          <ButtonText>Allow once</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
