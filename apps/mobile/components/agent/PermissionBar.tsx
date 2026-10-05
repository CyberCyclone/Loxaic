import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { useServerReachable } from '@/lib/connection';
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
  /**
   * Who is asking, when it is not the run on screen: a sub-agent's
   * description. Shown above the request, so a prompt that appears under the
   * parent's thread says which agent wants to run the tool.
   */
  source?: string;
  /** `agent.permission` unless a second bar can be on screen with it — the
   * one inside a sub-agent's panel. */
  testIDBase?: string;
}

export function PermissionBar({ tool, args, deadline, onAllow, onDeny, source, testIDBase = 'agent.permission' }: PermissionBarProps) {
  const mcp = splitMcpTool(tool);
  // See ToolApprovalDialog: an answer needs an open socket (#231).
  const disconnected = !useServerReachable();
  return (
    <VStack
      testID={`${testIDBase}.bar`}
      space="xs"
      className="border-t border-warning/30 bg-warning/10 px-4 py-3"
    >
      {source ? (
        <Text testID={`${testIDBase}.source`} size="xs" className="font-medium text-warning">
          Sub-agent · {source}
        </Text>
      ) : null}
      {mcp ? (
        <Text size="sm" className="text-foreground">
          MCP server <Text size="sm" className="font-mono text-warning">{mcp.server}</Text> wants to run{' '}
          <Text size="sm" className="font-mono text-warning">{mcp.tool}</Text>
          {' — '}
          <Text size="sm" className="font-mono text-muted-foreground">{summarizeArgs(tool, args)}</Text>
        </Text>
      ) : (
        <Text size="sm" className="text-foreground">
          {source ? 'It wants' : 'Agent wants'} to run <Text size="sm" className="font-mono text-warning">{tool}</Text>
          {' — '}
          <Text size="sm" className="font-mono text-muted-foreground">{summarizeArgs(tool, args)}</Text>
        </Text>
      )}
      <DeadlineCountdown kind="approval" deadline={deadline} testID={`${testIDBase}.deadline`} />
      <DisconnectedNote testID={`${testIDBase}.reconnecting`} />
      <HStack space="sm" className="justify-end">
        <Button testID={`${testIDBase}.deny`} variant="outline" size="sm" onPress={onDeny} isDisabled={disconnected}>
          <ButtonText>Deny</ButtonText>
        </Button>
        <Button testID={`${testIDBase}.allow`} size="sm" onPress={onAllow} isDisabled={disconnected}>
          <ButtonText>Allow once</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
