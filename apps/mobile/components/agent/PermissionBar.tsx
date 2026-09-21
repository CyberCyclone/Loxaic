import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import type { WaitDeadline } from '@/lib/pendingWaits';

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.command === 'string') return args.command;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.pattern === 'string') return args.pattern;
  const json = JSON.stringify(args);
  return json === '{}' ? tool : json.slice(0, 120);
}

/** MCP tools arrive namespaced as `server__tool`; builtins never contain `__`. */
function splitMcpTool(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) };
}

interface PermissionBarProps {
  tool: string;
  args: Record<string, unknown>;
  deadline?: WaitDeadline;
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionBar({ tool, args, deadline, onAllow, onDeny }: PermissionBarProps) {
  const mcp = splitMcpTool(tool);
  return (
    <VStack
      testID="agent.permission.bar"
      space="xs"
      className="border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      {mcp ? (
        <Text size="sm" className="text-foreground">
          MCP server <Text size="sm" className="font-mono text-warning">{mcp.server}</Text> wants to run{' '}
          <Text size="sm" className="font-mono text-warning">{mcp.tool}</Text>
          {' — '}
          <Text size="sm" className="font-mono text-muted-foreground">{summarizeArgs(tool, args)}</Text>
        </Text>
      ) : (
        <Text size="sm" className="text-foreground">
          Agent wants to run <Text size="sm" className="font-mono text-warning">{tool}</Text>
          {' — '}
          <Text size="sm" className="font-mono text-muted-foreground">{summarizeArgs(tool, args)}</Text>
        </Text>
      )}
      <DeadlineCountdown kind="approval" deadline={deadline} testID="agent.permission.deadline" />
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
