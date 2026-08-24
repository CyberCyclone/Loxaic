import { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { Message } from './Message';
import { TypingIndicator } from './TypingIndicator';
import type { Conversation } from '@/lib/types';

interface MessageListProps {
  conversation: Conversation | null;
  /** True while waiting on a response (send-time through first token/tool call). */
  pending?: boolean;
  /** True when the backend reported the target model isn't loaded yet. */
  loadingModel?: boolean;
}

export function MessageList({ conversation, pending, loadingModel }: MessageListProps) {
  const scrollRef = useRef<ScrollView>(null);

  // Design parity: only snap to bottom when the thread identity changes
  // (switching conversations), not on every streamed token.
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [conversation?.id]);

  if (!conversation) return null;

  // The assistant message placeholder only exists once the first delta (or
  // thinking/tool-call) event arrives, which can lag well behind send —
  // e.g. LM Studio JIT-loading a model. Until then, the last message is
  // still the user's — show a typing indicator so send isn't silent.
  const lastMsg = conversation.msgs[conversation.msgs.length - 1];
  const showTyping = pending && (!lastMsg || lastMsg.role === 'user');

  return (
    <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingVertical: 16 }}>
      <Box className="mx-auto w-full max-w-[820px]">
        {conversation.msgs.map((msg, i) => (
          <Message key={msg.id ?? i} msg={msg} />
        ))}
        {showTyping && <TypingIndicator loadingModel={loadingModel} />}
      </Box>
    </ScrollView>
  );
}
