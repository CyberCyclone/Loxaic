import type { PromptStats } from '@loxaic/api-client';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { FlatList, Platform, type ListRenderItemInfo, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Message } from './Message';
import { TypingIndicator } from './TypingIndicator';
import type { Conversation, Message as MessageType } from '@/lib/types';
import { useServerReachable } from '@/lib/connection';

const CONTENT_PADDING = 16;
/** How close to the newest message still counts as "following along". */
const STICKY_THRESHOLD = 120;

interface MessageListProps {
  conversation: Conversation | null;
  /** Epoch ms the current response started at (set at send time), or null when nothing's in flight. */
  responseStartedAt?: number | null;
  /** True when the backend reported the target model isn't loaded yet. */
  loadingModel?: boolean;
  /** Place in the inference queue while this run waits for a slot. */
  queuePosition?: number | null;
  /** Model the in-flight send targeted — shown on the typing indicator before any assistant message exists yet. */
  model?: string;
  /** What the in-flight request is evaluating — see TypingIndicator. */
  promptStats?: PromptStats | null;
  /** Scroll-back through history older than what is loaded (#213). Absent
   * where a thread has no server history to page through. */
  history?: MessageHistory | null;
}

/** What the session hooks expose for the open thread's scroll-back. */
export interface MessageHistory {
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

/**
 * Virtualised and inverted, both deliberately.
 *
 * Virtualised because a plain ScrollView renders and lays out *every* message,
 * so cost grows with the whole history rather than with what's on screen —
 * untenable once a thread reaches thousands of messages.
 *
 * Inverted because messages vary enormously in height (a single reply can be
 * thousands of pixels) and are never measured until rendered. That makes
 * "scroll to the end" unreliable by nature: the end is at an offset the list
 * can only estimate. Inverting puts the newest message at offset 0, so the
 * position we care about is a fixed, exactly-known one — the list simply opens
 * there, and following a live response is a scroll to zero rather than a chase
 * after a moving, half-measured target.
 */
export function MessageList({ conversation, responseStartedAt, loadingModel, queuePosition, model, promptStats, history }: MessageListProps) {
  const listRef = useRef<FlatList<MessageType>>(null);
  const pending = !!responseStartedAt;
  const reachable = useServerReachable();

  // Sticky-to-newest: true until the user deliberately scrolls back through
  // history. A streamed response only keeps following while that's still
  // where the user actually is — scrolling away to read earlier messages must
  // not get yanked back on the next token.
  const isNearBottomRef = useRef(true);
  // Whether the *user* is the one moving the list, on native. `onScroll`
  // fires for programmatic scrolls too, so without this the auto-follow reads
  // its own scroll back and can latch stickiness off mid-stream. The web does
  // not use it — see handleScroll.
  const userDraggingRef = useRef(false);

  const scrollToNewest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // Switching threads, or sending, re-arms the follow. Someone who just hit
  // send wants to watch the reply even if they'd scrolled up to re-read
  // history first. Keyed on the *newest* message rather than the count: an
  // older page arriving at the top changes the count too, and re-arming then
  // would throw someone reading back through history straight to the bottom
  // the moment the page they scrolled up for landed (#213).
  const newestId = conversation?.msgs.at(-1)?.id;
  useEffect(() => {
    isNearBottomRef.current = true;
    scrollToNewest();
  }, [conversation?.id, newestId, scrollToNewest]);

  const updateStickiness = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Inverted: offset 0 *is* the newest message, so distance from the live
    // edge is simply the current offset. No content-size arithmetic, and
    // nothing that depends on unmeasured items further up the history.
    isNearBottomRef.current = e.nativeEvent.contentOffset.y < STICKY_THRESHOLD;
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Native reports every drag, so only a drag's scrolls count there. The
    // web reports drags for touch only — a wheel, a trackpad, the scrollbar
    // and the keyboard all arrive as bare scroll events — and gating on them
    // left a desktop reader stuck to the newest message: every streamed token,
    // and every older page landing at the top (#213), threw them back down.
    // A window after each wheel event fixed the wheel and nothing else. So on
    // the web every scroll event is taken at its word: the list's own scrolls
    // only ever go to the newest message, offset 0, which reads back as
    // exactly that.
    if (Platform.OS !== 'web' && !userDraggingRef.current) return;
    updateStickiness(e);
  };

  const handleScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    updateStickiness(e);
    userDraggingRef.current = false;
  };

  const handleMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    updateStickiness(e);
    userDraggingRef.current = false;
  };

  // Content growing (a new token, a new message) while we're following the
  // live edge — hold position at the newest content.
  const handleContentSizeChange = () => {
    if (isNearBottomRef.current) scrollToNewest();
  };

  // The assistant message row is created immediately (a `message.start` event
  // lands as soon as the run begins), well before any real content — model
  // load and prompt processing both happen in the gap before the first token.
  // So "nothing to show yet" isn't just "no assistant message exists"; it's
  // "the assistant message exists but has neither thinking nor text yet".
  // A /compact run's summary message goes through the identical gap before
  // its first delta, so it gets the same placeholder treatment.
  const msgs = conversation?.msgs ?? [];
  const lastIndex = msgs.length - 1;
  // Asserted, not just annotated: a plain `const lastMsg = msgs[lastIndex]`
  // infers (and — for a `const`, narrows to) always-defined (no
  // noUncheckedIndexedAccess), which would make every `?.` below look
  // redundant to the linter even though `lastIndex` is -1 for an empty
  // conversation and `msgs[-1]` is genuinely undefined then.
  const lastMsg = msgs[lastIndex] as MessageType | undefined;
  const lastIsEmptyGenerating =
    !!lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'summary') && !lastMsg.thinking && !lastMsg.text;
  const showTyping = pending && (!lastMsg || lastMsg.role === 'user' || lastIsEmptyGenerating);
  // While the empty placeholder is represented by the typing indicator, don't
  // *also* render it as its own contentless row — that produced two stacked
  // "S" rows for the same in-flight response.
  const msgsToRender = pending && lastIsEmptyGenerating ? msgs.slice(0, lastIndex) : msgs;
  // Reasoning is "live" only for the last message, while it's still streaming
  // and hasn't moved on to the answer yet — once `text` starts, the model has
  // finished thinking even if this message object lingers.
  const liveThinkingIndex = pending && lastMsg?.role === 'assistant' && lastMsg.thinking && !lastMsg.text ? lastIndex : -1;
  // The elapsed-time readout carries all the way through the response —
  // prompt processing through generation — until real usage stats land.
  const liveElapsedIndex = pending && lastMsg?.role === 'assistant' && !lastMsg.usage ? lastIndex : -1;

  // Newest first, to match the inverted axis.
  const data = useMemo(() => [...msgsToRender].reverse(), [msgsToRender]);
  const lastRenderIndex = msgsToRender.length - 1;

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<MessageType>) => {
      // Undo the reversal to recover each message's true position, so the
      // live-thinking / elapsed markers still land on the right one.
      const originalIndex = lastRenderIndex - index;
      return (
        // Per-row centring rather than one wrapper around the whole list:
        // with virtualisation there is no single content wrapper to centre.
        <Box className="mx-auto w-full max-w-[820px]">
          <Message
            msg={item}
            liveThinking={originalIndex === liveThinkingIndex}
            elapsedSince={originalIndex === liveElapsedIndex ? responseStartedAt : null}
            isNewest={originalIndex === lastRenderIndex}
          />
        </Box>
      );
    },
    [lastRenderIndex, liveThinkingIndex, liveElapsedIndex, responseStartedAt],
  );

  if (!conversation) return null;

  return (
    <FlatList
      testID="chat.messageList"
      ref={listRef}
      className="flex-1"
      inverted
      data={data}
      keyExtractor={(item, index) => item.id ?? String(index)}
      renderItem={renderItem}
      // Inverted, so the header renders at the visual bottom — directly below
      // the newest message, which is where the typing indicator belongs.
      ListHeaderComponent={
        showTyping ? (
          <Box className="mx-auto w-full max-w-[820px]">
            <TypingIndicator
              loadingModel={loadingModel}
              queuePosition={queuePosition}
              promptStats={promptStats}
              since={responseStartedAt}
              model={model}
              compacting={lastMsg?.role === 'summary'}
            />
          </Box>
        ) : null
      }
      // Inverted, so the footer is the visual top — above the oldest loaded
      // message, which is where older history arrives. Reaching it loads the
      // next page by itself; the button is for when there was nothing to
      // scroll (a short page) and for anyone who prefers to ask.
      ListFooterComponent={
        history?.hasOlder ? (
          <Box className="mx-auto w-full max-w-[820px] items-center py-3">
            {history.loadingOlder ? (
              <Spinner testID="chat.history.loadingOlder" size="small" />
            ) : (
              <Pressable
                testID="chat.history.loadOlder"
                onPress={history.loadOlder}
                disabled={!reachable}
                className={`rounded-full bg-muted px-3 py-1.5 web:hover:bg-muted/80 ${reachable ? '' : 'opacity-50'}`}
              >
                <Text size="xs" className="text-muted-foreground">
                  Load earlier messages
                </Text>
              </Pressable>
            )}
          </Box>
        ) : null
      }
      // An older page is a request: scrolling to the top while the server is
      // unreachable would only fail, quietly, over and over.
      onEndReached={history?.hasOlder && !history.loadingOlder && reachable ? history.loadOlder : undefined}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingVertical: CONTENT_PADDING }}
      onScroll={handleScroll}
      onScrollBeginDrag={() => {
        userDraggingRef.current = true;
      }}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      onContentSizeChange={handleContentSizeChange}
      scrollEventThrottle={100}
      // Messages vary enormously in height, so keep a generous window: too
      // aggressive a setting blanks large items while scrolling past them.
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      windowSize={11}
    />
  );
}
