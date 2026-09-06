import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { formatTokens } from './KpiCard';
import type { ConversationStats } from '@loxaic/api-client';

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

export function ConversationStatsTable({ conversations }: { conversations: ConversationStats[] }) {
  if (conversations.length === 0) {
    return (
      <Text size="xs" className="text-muted-foreground">
        No conversations in this range
      </Text>
    );
  }

  return (
    <VStack space="xs">
      {conversations.map((c) => (
        <HStack
          key={c.conversationId}
          className="items-center justify-between rounded-md border border-border bg-card p-2.5"
        >
          <VStack className="flex-1 pr-2">
            <HStack space="xs" className="items-center">
              <Text size="sm" className="flex-1 text-foreground" numberOfLines={1}>
                {c.title}
              </Text>
              <Box className="rounded-sm border border-border px-1 py-0.5">
                <Text size="2xs" className="text-muted-foreground">
                  {c.kind}
                </Text>
              </Box>
            </HStack>
            <Text size="2xs" className="text-muted-foreground">
              {c.model} · {formatTimestamp(c.lastUsedAt)}
              {c.avgTtftMs != null ? ` · ${String(Math.round(c.avgTtftMs))}ms ttft` : ''}
            </Text>
          </VStack>
          <VStack className="items-end">
            <Text size="sm" className="text-foreground">
              {formatTokens(c.tokens)}
            </Text>
            <Text size="2xs" className="text-muted-foreground">
              {c.cachePct != null ? `${String(c.cachePct)}% reuse` : '— reuse'}
            </Text>
          </VStack>
        </HStack>
      ))}
    </VStack>
  );
}
