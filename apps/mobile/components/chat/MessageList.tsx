import { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { Message } from './Message';
import type { Conversation } from '@/lib/types';

export function MessageList({ conversation }: { conversation: Conversation | null }) {
  const scrollRef = useRef<ScrollView>(null);

  // Design parity: only snap to bottom when the thread identity changes
  // (switching conversations), not on every streamed token.
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [conversation?.id]);

  if (!conversation) return null;

  return (
    <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingVertical: 16 }}>
      <Box className="mx-auto w-full max-w-[820px]">
        {conversation.msgs.map((msg, i) => (
          <Message key={msg.id ?? i} msg={msg} />
        ))}
      </Box>
    </ScrollView>
  );
}
