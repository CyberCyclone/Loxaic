import { memo, useState } from 'react';
import { AlertCircle, Copy, GitFork, Square } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { attachmentClass, attachmentUrl } from '@loxaic/api-client';
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
import { DocumentPreview } from '@/components/viewer/DocumentPreview';
import { useSession } from '@/lib/session';
import { promptReuse } from '@/lib/usage';
import type { Message as MessageType } from '@/lib/types';

interface MessageProps {
  msg: MessageType;
  onFork?: () => void;
  /** True while this message's reasoning is still actively streaming in. */
  liveThinking?: boolean;
  /** Epoch ms the response started at — set only while this message is the one still in flight. */
  elapsedSince?: number | null;
  /** True for the newest message in the thread. Only it carries standing
   * notices about the conversation's current state. */
  isNewest?: boolean;
}

/** "photo.png" when the server knew a name, "An image"/"A file" when it didn't
 * — a bare ref would mean nothing to anyone. */
function describeOmitted(a: { mime: string; name?: string }): string {
  if (a.name) return `"${a.name}"`;
  return attachmentClass(a.mime) === 'image' ? 'An image' : 'A file';
}

/** Names every dropped file, capped so a pathological thread can't turn the
 * notice into a wall of text. */
function listOmitted(atts: { mime: string; name?: string }[], max = 4): string {
  const shown = atts.slice(0, max).map(describeOmitted).join(', ');
  const rest = atts.length - max;
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

function MessageInner({ msg, onFork, liveThinking, elapsedSince, isNewest }: MessageProps) {
  // Hoisted above the summary early-return below: hooks can't be called
  // conditionally, and a summary card renders no attachments anyway.
  const { token } = useSession();
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [previewAtt, setPreviewAtt] = useState<NonNullable<MessageType['attachments']>[number] | null>(null);
  const reuse = msg.usage ? promptReuse(msg.usage) : null;
  const omitted = msg.usage?.omittedAttachments ?? [];

  // A compaction summary isn't a conversational turn from either party — it
  // renders as a divider card, not a bubble, and skips everything below
  // (avatar, usage row, copy/fork actions) that assumes one.
  if (msg.role === 'summary') {
    return (
      <CompactionCard
        stats={msg.compaction}
        summaryText={msg.text || undefined}
        failed={msg.error}
        errorText={msg.errorText}
      />
    );
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
              <AttachmentThumbs
                attachments={msg.attachments}
                token={token}
                onPress={(att) => {
                  if (attachmentClass(att.mime) === 'image') {
                    setViewerUri(att.localUri ?? (att.ref && token ? attachmentUrl(att.ref, token) : undefined) ?? null);
                  } else {
                    setPreviewAtt(att);
                  }
                }}
              />
            )}
            {msg.error ? (
              <VStack space="xs">
                {/* Whatever streamed before the failure is still real output,
                    so it stays readable above the reason rather than being
                    replaced by it. */}
                {!!msg.text && <Markdown text={msg.text} />}
                <HStack space="xs" className="items-start">
                  <Icon as={AlertCircle} size="xs" className="mt-0.5 text-destructive" />
                  {/* The fallback is for rows that predate the stored reason.
                      It deliberately guesses at nothing: an invented cause is
                      worse than admitting we were not told one. Plain Text,
                      never Markdown: the reason is an upstream error body,
                      stored and shown to every reader of the thread (see the
                      server's streams/error-text.ts). */}
                  <Text testID="chat.message.error" className="flex-1 text-destructive">
                    {msg.errorText ?? 'This response failed.'}
                  </Text>
                </HStack>
              </VStack>
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
                {msg.usage.promptTps != null ? (
                  <Text testID="chat.usage.promptRate" size="xs" className="text-muted-foreground">
                    {Math.round(msg.usage.promptTps)} tok/s prompt
                  </Text>
                ) : msg.usage.ttftMs != null ? (
                  // No prompt rate to show: the backend didn't say how many
                  // prompt tokens it actually evaluated, and dividing the whole
                  // prompt by TTFT is not a speed once any of it was cached.
                  <Text testID="chat.usage.promptCost" size="xs" className="text-muted-foreground">
                    {(msg.usage.ttftMs / 1000).toFixed(1)}s prompt
                  </Text>
                ) : null}
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
                {reuse && (
                  <Text testID="chat.usage.reuse" size="xs" className="text-muted-foreground">
                    {reuse.pct}% {reuse.measured ? 'cached' : 'reused'}
                  </Text>
                )}
              </HStack>
            )}

            {!isUser && isNewest && omitted.length > 0 && (
              // Next to the answer it explains, rather than on the thumbnail
              // upstream: the moment it matters is when a reply looks like it
              // ignored a file. The transcript still shows the attachment,
              // because it was genuinely sent — the model just couldn't be
              // given it.
              //
              // Newest message only. Being over budget is a standing condition,
              // re-derived over the whole replay every turn, so rendering it
              // per-message would staple the same sentence to every subsequent
              // reply — including ones the user attached nothing to.
              <Box
                testID="chat.usage.omittedAttachments"
                className="mt-1 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
              >
                <Text size="2xs" className="text-muted-foreground">
                  {/* Every file is named. "2 attachments weren't sent" leaves
                      the user unable to tell whether it dropped the
                      spreadsheet that mattered or the screenshot that didn't —
                      no better off than silence. */}
                  {omitted.length === 1
                    ? `${describeOmitted(omitted[0])} wasn't sent to the model: this conversation has more attachments than fit in its context.`
                    : `${String(omitted.length)} attachments weren't sent to the model — ${listOmitted(omitted)} — because this conversation has more attachments than fit in its context.`}
                  {' '}
                  {/* Deliberately not "re-attach it". Re-attaching does bring
                      that file back, but it pushes another out of the history
                      pool in its place: measured on four over-budget files, the
                      dropped file simply alternates and the notice never
                      clears. Compacting frees the budget for real, because the
                      replay then starts after the summary and the older
                      attachment turns are no longer counted. */}
                  Compacting the conversation or starting a new one will make room.
                </Text>
              </Box>
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
      {isUser && <DocumentPreview attachment={previewAtt} onClose={() => { setPreviewAtt(null); }} />}
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
