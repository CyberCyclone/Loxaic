import { Fragment } from 'react';
import { AlertCircle, Copy, GitFork } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { CodeBlock } from './CodeBlock';
import type { Message as MessageType } from '@/lib/types';

const FENCE_RE = /```(\w+)?\n([\s\S]*?)```/g;

// The design's entire "markdown" handling: split fenced code blocks out of
// plain text. Everything else renders as raw text — matching source parity.
function renderText(text: string) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={key++} className="text-card-foreground">
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    parts.push(<CodeBlock key={key++} code={match[2]} lang={match[1]} />);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(
      <Text key={key++} className="text-card-foreground">
        {text.slice(lastIndex)}
      </Text>,
    );
  }
  return parts;
}

interface MessageProps {
  msg: MessageType;
  onFork?: () => void;
  /** True while this message's reasoning is still actively streaming in. */
  liveThinking?: boolean;
}

export function Message({ msg, onFork, liveThinking }: MessageProps) {
  const isUser = msg.role === 'user';

  return (
    <Box className={`px-4 py-2 ${isUser ? 'bg-primary/5' : ''}`}>
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

          {msg.thinking && <ThinkingBlock text={msg.thinking} live={liveThinking} />}
          {msg.tools?.map((tool, i) => <ToolCallCard key={i} tool={tool} />)}
          {msg.error ? (
            <HStack space="xs" className="items-start">
              <Icon as={AlertCircle} size="xs" className="mt-0.5 text-destructive" />
              <Text className="flex-1 text-destructive">{msg.text}</Text>
            </HStack>
          ) : (
            <Fragment>{renderText(msg.text)}</Fragment>
          )}

          {!isUser && msg.usage && (
            <HStack space="md" className="flex-wrap pt-1">
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
                onPress={() => Clipboard.setStringAsync(msg.text)}
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
  );
}
