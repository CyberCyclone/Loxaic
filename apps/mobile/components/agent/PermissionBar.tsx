import { useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { DeadlineCountdown } from '@/components/chat/DeadlineCountdown';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { useServerReachable } from '@/lib/connection';
import type { WaitDeadline } from '@/lib/pendingWaits';
import { permissionBarView } from '@/lib/permissionBar';
import { useSession } from '@/lib/session';
import type { PermissionMode } from '@loxaic/api-client';

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.command === 'string') return args.command;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.pattern === 'string') return args.pattern;
  const json = JSON.stringify(args);
  return json === '{}' ? tool : json.slice(0, 120);
}

interface PermissionBarProps {
  tool: string;
  args: Record<string, unknown>;
  deadline?: WaitDeadline;
  /** The asking run's mode and the user whose "Allow always" the server
   * records, both from the approval itself — see `permissionBarView`. */
  mode?: PermissionMode;
  granterUserId?: string;
  onAllow: () => void;
  /** Approves this call and stops the tool asking (#266). Offered only when
   * given, and only to the person it would be recorded for. */
  onAllowAlways?: () => void;
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

export function PermissionBar({
  tool,
  args,
  deadline,
  mode,
  granterUserId,
  onAllow,
  onAllowAlways,
  onDeny,
  source,
  testIDBase = 'agent.permission',
}: PermissionBarProps) {
  const { user } = useSession();
  const view = permissionBarView({ tool, mode, granterUserId }, user?.id);
  const { mcp } = view;
  const offerAlways = onAllowAlways !== undefined && view.canAllowAlways;
  const alwaysFirst = offerAlways && view.primary === 'always';
  // On a phone the keyboard leaves about a hundred points between the header
  // and the composer, and the bar's buttons were cut off below it: a run
  // parked on a question nobody could reach the answer to. The prompt is what
  // needs attention, so the keyboard goes; whatever was typed stays. Not on the
  // web, where this would take focus from someone typing ahead at a desk.
  useEffect(() => {
    if (Platform.OS !== 'web') Keyboard.dismiss();
  }, []);
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
      {offerAlways && view.note ? (
        <Text testID={`${testIDBase}.alwaysNote`} size="2xs" className="text-muted-foreground">
          {view.note}
        </Text>
      ) : null}
      <DeadlineCountdown kind="approval" deadline={deadline} testID={`${testIDBase}.deadline`} />
      <DisconnectedNote testID={`${testIDBase}.reconnecting`} />
      <HStack space="sm" className="justify-end">
        <Button testID={`${testIDBase}.deny`} variant="outline" size="sm" onPress={onDeny} isDisabled={disconnected}>
          <ButtonText>Deny</ButtonText>
        </Button>
        {/* The same two answers in every mode, under the same ids: only which
            one is filled changes. The filled one is last, nearest the thumb. */}
        {alwaysFirst ? (
          <Button testID={`${testIDBase}.allow`} variant="outline" size="sm" onPress={onAllow} isDisabled={disconnected}>
            <ButtonText>Allow once</ButtonText>
          </Button>
        ) : null}
        {offerAlways ? (
          <Button
            testID={`${testIDBase}.allowAlways`}
            variant={alwaysFirst ? 'default' : 'outline'}
            size="sm"
            onPress={onAllowAlways}
            isDisabled={disconnected}
          >
            <ButtonText>Allow always</ButtonText>
          </Button>
        ) : null}
        {alwaysFirst ? null : (
          <Button testID={`${testIDBase}.allow`} size="sm" onPress={onAllow} isDisabled={disconnected}>
            <ButtonText>Allow once</ButtonText>
          </Button>
        )}
      </HStack>
    </VStack>
  );
}
