import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { useServerReachable } from '@/lib/connection';
import type { AdminMessage } from '@loxaic/api-client';

interface AdminTranscriptProps {
  messages: AdminMessage[];
  loading: boolean;
  /** Whether older messages exist than the ones shown — the transcript opens
   * on the newest page (#213). */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

/** One message's readable text, plus the names of anything attached.
 *
 * Attachments are named and never fetched: `/v1/files/:ref` refuses a deleted
 * conversation's uploads, and it should keep doing so — knowing a spreadsheet
 * was attached is what an audit needs, and serving its bytes through a second
 * door would quietly undo that. */
function describe(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as { kind?: string; text?: string; name?: string; tool?: string };
    if (block.kind === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.kind === 'attachment') parts.push(`[attachment: ${block.name ?? 'unnamed'}]`);
    else if (block.kind === 'tool_call') parts.push(`[tool: ${block.tool ?? 'unknown'}]`);
  }
  return parts.join('\n');
}

const AUTHOR_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
  summary: 'Summary',
};

/**
 * A conversation's messages, read-only, on the admin screen.
 *
 * Deliberately plain — no markdown, no bubbles, no attachment thumbnails.
 * This is the audit view, where an admin needs to read what was said and quote
 * it; rendering it like the chat surface would invite acting in it, which this
 * screen cannot do.
 */
export function AdminTranscript({ messages, loading, hasOlder, loadingOlder = false, onLoadOlder }: AdminTranscriptProps) {
  const reachable = useServerReachable();
  if (loading) {
    return (
      <Text size="sm" className="text-muted-foreground">
        Loading transcript…
      </Text>
    );
  }
  if (messages.length === 0) {
    return (
      <Text testID="admin.transcript.empty" size="sm" className="text-muted-foreground">
        No messages.
      </Text>
    );
  }
  return (
    <VStack testID="admin.transcript" space="sm">
      {hasOlder && onLoadOlder && (
        <Button
          testID="admin.transcript.loadOlder"
          variant="outline"
          size="sm"
          isDisabled={loadingOlder || !reachable}
          onPress={onLoadOlder}
          className="self-start"
        >
          <ButtonText>{loadingOlder ? 'Loading…' : 'Load older messages'}</ButtonText>
        </Button>
      )}
      {messages.map((m) => (
        <Box key={m.id} className="rounded-md border border-border bg-card px-2.5 py-2">
          <HStack space="xs" className="items-center">
            <Text size="2xs" className="font-medium text-foreground">
              {AUTHOR_LABEL[m.authorType] ?? m.authorType}
            </Text>
            <Text size="2xs" className="text-muted-foreground">
              {new Date(m.createdAt).toLocaleString()}
              {m.model ? ` · ${m.model}` : ''}
            </Text>
          </HStack>
          <Text size="xs" className="text-foreground">
            {describe(m.content)}
          </Text>
        </Box>
      ))}
    </VStack>
  );
}
