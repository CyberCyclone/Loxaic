import { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { Message } from './Message';
import { TypingIndicator } from './TypingIndicator';
import type { Conversation } from '@/lib/types';

interface MessageListProps {
  conversation: Conversation | null;
  /** Epoch ms the current response started at (set at send time), or null when nothing's in flight. */
  responseStartedAt?: number | null;
  /** True when the backend reported the target model isn't loaded yet. */
  loadingModel?: boolean;
  /** Model the in-flight send targeted — shown on the typing indicator before any assistant message exists yet. */
  model?: string;
}

export function MessageList({ conversation, responseStartedAt, loadingModel, model }: MessageListProps) {
  const scrollRef = useRef<ScrollView>(null);
  const pending = !!responseStartedAt;

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
  const lastIndex = conversation.msgs.length - 1;
  const lastMsg = conversation.msgs[lastIndex];
  const showTyping = pending && (!lastMsg || lastMsg.role === 'user');
  // Reasoning is "live" only for the last message, while it's still
  // streaming and hasn't moved on to the answer yet — once `text` starts,
  // the model has finished thinking even if this message object lingers.
  const liveThinkingIndex = pending && lastMsg?.role === 'assistant' && lastMsg.thinking && !lastMsg.text ? lastIndex : -1;
  // The elapsed-time readout carries all the way through the response —
  // prompt processing through generation — until real usage stats land.
  const liveElapsedIndex = pending && lastMsg?.role === 'assistant' && !lastMsg.usage ? lastIndex : -1;

  return (
    <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingVertical: 16 }}>
      <Box className="mx-auto w-full max-w-[820px]">
        {conversation.msgs.map((msg, i) => (
          <Message
            key={msg.id ?? i}
            msg={msg}
            liveThinking={i === liveThinkingIndex}
            elapsedSince={i === liveElapsedIndex ? responseStartedAt : null}
          />
        ))}
        {showTyping && <TypingIndicator loadingModel={loadingModel} since={responseStartedAt!} model={model} />}
      </Box>
    </ScrollView>
  );
}
