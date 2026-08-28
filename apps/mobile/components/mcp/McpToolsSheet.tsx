import { useCallback, useEffect, useState } from 'react';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
  ActionsheetScrollView,
} from '@/components/ui/actionsheet';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Badge, BadgeText } from '@/components/ui/badge';
import type { McpDiscoveredTool, McpServer, McpServerInput, McpTestResult, McpToolPolicy } from '@shannon/api-client';

const APPROVALS: { value: McpToolPolicy['approval']; label: string }[] = [
  { value: 'ask', label: 'Ask first' },
  { value: 'allow', label: 'Always allow' },
];

interface McpToolsSheetProps {
  server: McpServer | null;
  onClose: () => void;
  test: (id: string) => Promise<McpTestResult>;
  update: (id: string, patch: McpServerInput) => Promise<unknown>;
}

/** Discovered-tool list with per-tool policy controls. Fetches on open via
 * test-connection so the listing is always live, not a stale snapshot. */
export function McpToolsSheet({ server, onClose, test, update }: McpToolsSheetProps) {
  const [tools, setTools] = useState<McpDiscoveredTool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!server) return;
    setLoading(true);
    setError(null);
    setTools([]);
    test(server.id)
      .then((result) => {
        if (result.ok) setTools(result.tools);
        else setError(result.error);
      })
      .catch(() => { setError('Could not reach the server'); })
      .finally(() => { setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id]);

  const patchPolicy = useCallback(
    async (tool: McpDiscoveredTool, patch: Partial<McpToolPolicy>) => {
      if (!server) return;
      const next = { ...tool.policy, ...patch };
      setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, policy: { ...next, changed: false } } : t)));
      try {
        await update(server.id, { toolPolicies: { [tool.name]: patch } });
      } catch {
        setTools((prev) => prev.map((t) => (t.name === tool.name ? tool : t)));
      }
    },
    [server, update],
  );

  return (
    <Actionsheet isOpen={!!server} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent testID="mcp.toolsSheet.dialog" className="max-h-[80%]">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        <ActionsheetScrollView>
          <VStack space="sm" className="w-full p-3">
            <Text className="font-semibold text-foreground">{server?.name} — Tools</Text>
            {loading ? (
              <Spinner />
            ) : error ? (
              <Text size="sm" className="text-destructive">
                {error}
              </Text>
            ) : tools.length === 0 ? (
              <Text size="sm" className="text-muted-foreground">
                No tools discovered
              </Text>
            ) : (
              tools.map((tool) => (
                <VStack key={tool.name} testID={`mcp.toolRow.${tool.name}`} space="xs" className="border-b border-border py-2">
                  <HStack className="items-center justify-between">
                    <HStack space="xs" className="flex-1 items-center pr-2">
                      <Text size="sm" className="font-medium text-foreground" numberOfLines={1}>
                        {tool.name}
                      </Text>
                      {tool.policy.changed && (
                        <Badge variant="destructive">
                          <BadgeText className="normal-case">changed</BadgeText>
                        </Badge>
                      )}
                      {tool.policy.missing && (
                        <Badge variant="outline">
                          <BadgeText className="normal-case">missing</BadgeText>
                        </Badge>
                      )}
                    </HStack>
                    <Switch
                      testID={`mcp.toolEnable.${tool.name}`}
                      size="sm"
                      value={tool.policy.enabled}
                      onValueChange={(enabled) => patchPolicy(tool, { enabled })}
                    />
                  </HStack>

                  {!!tool.description && (
                    <Text size="xs" className="text-muted-foreground" numberOfLines={3}>
                      {tool.description}
                    </Text>
                  )}

                  {tool.annotations && (
                    <Text size="2xs" className="text-muted-foreground">
                      Server claims (unverified):{' '}
                      {[
                        tool.annotations.readOnlyHint !== undefined &&
                          `read-only: ${tool.annotations.readOnlyHint ? 'yes' : 'no'}`,
                        tool.annotations.destructiveHint !== undefined &&
                          `destructive: ${tool.annotations.destructiveHint ? 'yes' : 'no'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  )}

                  <HStack space="xs" className="items-center">
                    {APPROVALS.map((a) => (
                      <Pressable
                        key={a.value}
                        testID={`mcp.toolApproval.${tool.name}.${a.value}`}
                        onPress={() => { void patchPolicy(tool, { approval: a.value }); }}
                        className={`rounded-full px-3 py-1 ${tool.policy.approval === a.value ? 'bg-primary/15' : 'bg-muted'}`}
                      >
                        <Text
                          size="xs"
                          className={tool.policy.approval === a.value ? 'text-primary' : 'text-muted-foreground'}
                        >
                          {a.label}
                        </Text>
                      </Pressable>
                    ))}
                    <Pressable
                      testID={`mcp.toolReadOnly.${tool.name}`}
                      onPress={() => { void patchPolicy(tool, { readOnly: !tool.policy.readOnly }); }}
                      className={`rounded-full px-3 py-1 ${tool.policy.readOnly ? 'bg-primary/15' : 'bg-muted'}`}
                    >
                      <Text size="xs" className={tool.policy.readOnly ? 'text-primary' : 'text-muted-foreground'}>
                        Read-only
                      </Text>
                    </Pressable>
                  </HStack>
                  <Text size="2xs" className="text-muted-foreground">
                    Read-only allows use in planning mode. You assert this — the server's own claims are never
                    trusted.
                  </Text>
                </VStack>
              ))
            )}
          </VStack>
        </ActionsheetScrollView>
      </ActionsheetContent>
    </Actionsheet>
  );
}
