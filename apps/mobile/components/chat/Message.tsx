import { memo, useState } from 'react';
import { AlertCircle, Copy, GitFork, Square } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Markdown } from '@/components/markdown/Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { LiveElapsed } from './LiveElapsed';
import { CompactionCard } from './CompactionCard';
import { AttachmentThumbs } from './AttachmentThumbs';
import { ImageViewer } from '@/components/viewer/ImageViewer';
import { useSession } from '@/lib/session';
import type { Message as MessageType } from '@/lib/types';

interface MessageProps {
  msg: MessageType;
  onFork?: () => void;
  /** True while this message's reasoning is still actively streaming in. */
  liveThinking?: boolean;
  /** Epoch ms the response started at — set only while this message is the one still in flight. */
  elapsedSince?: number | null;
}

function MessageInner({ msg, onFork, liveThinking, elapsedSince }: MessageProps) {
  // Hoisted above the summary early-return below: hooks can't be called
  // conditionally, and a summary card renders no attachments anyway.
  const { token } = useSession();
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  // A compaction summary isn't a conversational turn from either party — it
  // renders as a divider card, not a bubble, and skips everything below
  // (avatar, usage row, copy/fork actions) that assumes one.
  if (msg.role === 'summary') {
    return <CompactionCard stats={msg.compaction} summaryText={msg.text || undefined} />;
  }

  const isUser = msg.role === 'user';

  return (
    <>
      <Box
        testID={`chat.message.${msg.role}`}
        className={`px-4 py-2 ${isUser ? 'bg-primary/5' : ''}`}
      >
        <HStack space="sm" className="items-start">
          <Box
            className={`h-6 w-6 items-center justify-center rounded-full ${
              isUser ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <Text size="xs" className={isUser ? 'text-primary-foreground' : 'text-foreground'}>
              {isUser ? 'U' : 'S'}
            </Text>
          </Box>
          <VStack className="flex-1 pl-0" space="xs">
            <HStack space="xs" className="items-center">
              {!isUser && msg.model && (
                <Text size="xs" className="text-muted-foreground">
                  {msg.model}
                </Text>
              )}
            </HStack>

            {msg.thinking && <ThinkingBlock text={msg.thinking} live={liveThinking} since={elapsedSince} />}
            {msg.tools?.map((tool, i) => <ToolCallCard key={i} tool={tool} />)}
            {isUser && !!msg.attachments?.length && (
              <AttachmentThumbs attachments={msg.attachments} token={token} onPress={setViewerUri} />
            )}
            {msg.error ? (
              <HStack space="xs" className="items-start">
                <Icon as={AlertCircle} size="xs" className="mt-0.5 text-destructive" />
                <Text className="flex-1 text-destructive">{msg.text}</Text>
              </HStack>
            ) : isUser ? (
              // User bubbles stay plain: someone typing a literal `*` or `#`
              // should see exactly what they typed.
              <Text className="text-card-foreground">{msg.text}</Text>
            ) : (
              <Markdown text={msg.text} />
            )}

            {!isUser && msg.stopped && (
              <HStack space="xs" className="items-center pt-1">
                <Icon as={Square} size="xs" className="text-muted-foreground" />
                <Text size="xs" className="text-muted-foreground">
                  Stopped
                </Text>
              </HStack>
            )}

            {/* While reasoning is live, ThinkingBlock already shows this same
                elapsed readout next to its spinner — this row is for the
                phase after that (generating the answer text, before usage
                lands), where nothing else on screen is showing it. */}
            {!isUser && !msg.usage && !!elapsedSince && !liveThinking && (
              <HStack space="xs" className="items-center pt-1">
                <Box className="h-1.5 w-1.5 rounded-full bg-primary" />
                <LiveElapsed since={elapsedSince} />
              </HStack>
            )}

            {!isUser && msg.usage && (
              <HStack space="md" className="flex-wrap pt-1">
                {!!msg.usage.totalMs && (
                  <Text size="xs" className="text-muted-foreground">
                    {(msg.usage.totalMs / 1000).toFixed(1)}s
                  </Text>
                )}
                {!!msg.usage.promptTps && (
                  <Text size="xs" className="text-muted-foreground">
                    {Math.round(msg.usage.promptTps)} tok/s prompt
                  </Text>
                )}
                {msg.usage.tps > 0 && (
                  <Text size="xs" className="text-muted-foreground">
                    {Math.round(msg.usage.tps)} tok/s gen
                  </Text>
                )}
                <Text size="xs" className="text-muted-foreground">
                  {msg.usage.in.toLocaleString()} in
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  {msg.usage.out.toLocaleString()} out
                </Text>
                {msg.usage.cache > 0 && (
                  <Text size="xs" className="text-muted-foreground">
                    {msg.usage.cache}% cache
                  </Text>
                )}
              </HStack>
            )}

            {!isUser && (
              <HStack space="sm" className="pt-1">
                <Pressable
                  onPress={() => { void Clipboard.setStringAsync(msg.text); }}
                  className="flex-row items-center gap-1 rounded-sm p-1 web:hover:bg-muted/50"
                >
                  <Icon as={Copy} size="xs" className="text-muted-foreground" />
                </Pressable>
                {onFork && (
                  <Pressable
                    onPress={onFork}
                    className="flex-row items-center gap-1 rounded-sm p-1 web:hover:bg-muted/50"
                  >
                    <Icon as={GitFork} size="xs" className="text-muted-foreground" />
                  </Pressable>
                )}
              </HStack>
            )}
          </VStack>
        </HStack>
      </Box>
      {isUser && <ImageViewer uri={viewerUri} onClose={() => { setViewerUri(null); }} />}
    </>
  );
}

/**
 * Memoised deliberately. A long thread holds tens of thousands of pixels of
 * content, and during streaming only the final message actually changes —
 * without this, every token re-renders and re-lays-out the entire history,
 * which is what starves the ScrollView's own content measurement and leaves
 * the newest content unreachable behind the composer.
 */
export const Message = memo(
  MessageInner,
  (prev, next) =>
    prev.msg === next.msg &&
    prev.liveThinking === next.liveThinking &&
    prev.elapsedSince === next.elapsedSince &&
    prev.onFork === next.onFork,
);
