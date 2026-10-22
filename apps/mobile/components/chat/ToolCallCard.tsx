import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { attachmentUrl } from '@loxaic/api-client';
import {
  ChevronRight,
  FileText,
  FilePen,
  FileEdit,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  ListTodo,
  HelpCircle,
  Plug,
  BookOpen,
  AppWindowMac,
} from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { ToolCall } from '@/lib/types';
import { permissionBadge } from '@/lib/permissionBar';
import { useSession } from '@/lib/session';
import { ImageViewer } from '@/components/viewer/ImageViewer';
import { CARD_VALUE_MAX_HEIGHT, ToolCallDetails } from '@/components/chat/ToolCallDetails';
import { TRUNCATE_TEXT, WRAP_ANYWHERE } from '@/lib/truncate';

const TOOL_ICONS: Record<string, typeof FileText> = {
  fs_read: FileText,
  fs_write: FilePen,
  fs_edit: FileEdit,
  bash: Terminal,
  grep: Search,
  glob: FolderSearch,
  web_fetch: Globe,
  todo_write: ListTodo,
  skill: BookOpen,
};

const TOOL_TINT: Record<string, string> = {
  fs_read: 'text-primary bg-primary/15',
  fs_write: 'text-destructive bg-destructive/15',
  fs_edit: 'text-warning bg-warning/15',
  bash: 'text-success bg-success/15',
  grep: 'text-muted-foreground bg-muted',
  glob: 'text-muted-foreground bg-muted',
  web_fetch: 'text-muted-foreground bg-muted',
  todo_write: 'text-primary-hover bg-primary/15',
  skill: 'text-primary bg-primary/15',
};

/** MCP tools arrive namespaced as `server__tool`; builtins never contain `__`. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) };
}

export function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const { token } = useSession();
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const mcp = splitMcpTool(tool.tool);
  // A web_fetch that went through the chat's own browser (#281) says so: the
  // plain fetch and the browser answer differently, and the person should be
  // able to tell which one they are reading.
  const ToolIcon = mcp ? Plug : tool.browser ? AppWindowMac : (TOOL_ICONS[tool.tool] ?? HelpCircle);
  // A failed call used to render identically to a successful one, so the only
  // sign anything had gone wrong was the model talking about it afterwards —
  // and a card collapsed by default hid the reason. Tinted on a positive
  // `false` only: all three paths now carry `ok` — the live event, the
  // reconnect snapshot, and history rebuilt from REST — so an absent `ok`
  // means the row predates the field. That is "we were not told", which is
  // still not success. See the same note in `lib/types.ts`.
  const failed = tool.ok === false;
  const id = tool.callId;
  // No result has come back yet: the call is waiting for approval or running.
  // Every way a call ends — run, refused, expired, stopped — sends a result.
  const pending = tool.result === '' && tool.ok === undefined;
  const tint = failed
    ? 'text-destructive bg-destructive/15'
    : mcp
      ? 'text-primary bg-primary/15'
      : (TOOL_TINT[tool.tool] ?? 'text-muted-foreground bg-muted');

  return (
    <Box
      testID={tool.callId ? `chat.toolCall.${tool.callId}` : undefined}
      className={`my-1.5 rounded-md border bg-card ${failed ? 'border-destructive/40' : 'border-border'}`}
    >
      {/* The label goes on the Pressable, not on the tinted Box below it.
          `components/ui/box/index.web.tsx` destructures only `className` and
          `testID` and spreads the rest onto a raw `<div>`, so there is no
          `accessibilityLabel` → `aria-label` mapping in that path: the prop
          reaches the DOM as an unknown attribute and the card has no
          accessible name on web or Electron. (Same `.web.tsx` override caveat
          apps/mobile/components/AGENTS.md records for testIDs, which work
          only because they were patched in by hand.) Native is no better — a
          plain View with a label but no `accessible` is not an accessibility
          element. The Pressable is already the focusable element that owns
          the row, so the failure folds into what it announces. */}
      <Pressable
        testID={tool.callId ? `chat.toolCall.header.${tool.callId}` : undefined}
        onPress={() => { setOpen((o) => !o); }}
        accessibilityLabel={
          [tool.browser ? 'Opened in a browser' : null, failed ? 'Tool call failed' : null].filter(Boolean).join(', ') || undefined
        }
      >
        <HStack className="min-w-0 items-center gap-2 px-3 py-2">
          {/* The failure is carried by colour alone otherwise, which no test
              can select on. */}
          <Box
            testID={failed && tool.callId ? `chat.toolCall.failed.${tool.callId}` : undefined}
            className={`h-5 w-5 items-center justify-center rounded-sm ${tint}`}
          >
            {tool.browser ? (
              <Box testID={tool.callId ? `chat.toolCall.browser.${tool.callId}` : undefined}>
                <Icon as={ToolIcon} size="xs" />
              </Box>
            ) : (
              <Icon as={ToolIcon} size="xs" />
            )}
          </Box>
          {/* One line on web as on native: the whole call is in the dropdown
              (#267), so the header need not wrap to show it. */}
          <Text size="sm" className="min-w-0 flex-1 text-card-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {mcp ? (
              <>
                {`${mcp.server} · ${mcp.tool}`}
                {tool.summary && tool.summary !== '{}' ? (
                  <Text size="sm" className="text-muted-foreground">{`  ${tool.summary}`}</Text>
                ) : null}
              </>
            ) : (
              tool.summary
            )}
          </Text>
          {tool.duration && (
            <Text size="xs" className="text-muted-foreground">
              {tool.duration}
            </Text>
          )}
          <Icon
            as={ChevronRight}
            size="xs"
            className="text-muted-foreground"
            style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
          />
        </HStack>
      </Pressable>
      {permissionBadge(tool.permission) ? (
        <Text
          testID={tool.callId ? `chat.toolCall.permission.${tool.callId}` : undefined}
          size="2xs"
          className="px-3 pb-2 text-muted-foreground"
        >
          {permissionBadge(tool.permission)}
        </Text>
      ) : null}
      {/* A web_fetch screenshot (#281) shows outside the collapsed body: it is
          the result a person wants to see, not detail behind a tap. */}
      {tool.images?.length && token ? (
        <HStack space="sm" className="flex-wrap px-3 pb-2">
          {tool.images.map((image) => {
            const uri = attachmentUrl(image.ref, token);
            return (
              <Pressable
                key={image.ref}
                testID={tool.callId ? `chat.toolCall.screenshot.${tool.callId}` : undefined}
                accessibilityLabel="Open the screenshot"
                onPress={() => { setViewerUri(uri); }}
                className="h-24 w-40 overflow-hidden rounded-md border border-border"
              >
                <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" />
              </Pressable>
            );
          })}
        </HStack>
      ) : null}
      {tool.images?.length ? <ImageViewer uri={viewerUri} onClose={() => { setViewerUri(null); }} /> : null}
      {open && (
        <Box className="border-t border-border">
          {/* Everything the call was given, in full (#267) — while it waits
              for approval or runs as much as after. */}
          <Box className="border-b border-border px-3 py-2">
            <ToolCallDetails
              tool={tool.tool}
              args={tool.args}
              argTestID={id ? (key) => `chat.toolCall.arg.${id}.${key}` : undefined}
              capped
            />
          </Box>
          {tool.diff ? (
            <ScrollView testID={id ? `chat.toolCall.result.${id}` : undefined} style={{ maxHeight: CARD_VALUE_MAX_HEIGHT }}>
              {tool.diff.map((line, i) => (
                <Text
                  key={i}
                  numberOfLines={1}
                  className={
                    line.type === 'add'
                      ? 'bg-success/10 text-success'
                      : line.type === 'del'
                        ? 'bg-destructive/10 text-destructive'
                        : 'text-muted-foreground'
                  }
                  style={{ fontFamily: 'monospace', fontSize: 12, paddingHorizontal: 12, paddingVertical: 1 }}
                >
                  {line.text}
                </Text>
              ))}
            </ScrollView>
          ) : pending ? (
            <Text testID={id ? `chat.toolCall.pending.${id}` : undefined} size="xs" className="p-3 text-muted-foreground">
              No result yet
            </Text>
          ) : (
            <ScrollView testID={id ? `chat.toolCall.result.${id}` : undefined} style={{ maxHeight: CARD_VALUE_MAX_HEIGHT }}>
              <Text
                // On the Text as well as the scroll view: XCUITest reports a
                // scroll view's text as empty, so the words are only readable here.
                testID={id ? `chat.toolCall.resultText.${id}` : undefined}
                // `leading-[18px]`, not `lineHeight: 18`: on web this Text is a
                // <span>, where the number is a multiplier — 216px a line, taller
                // than the box, so the output sat centred in it and cut off.
                className="p-3 text-[12px] leading-[18px] text-muted-foreground"
                style={{ fontFamily: 'monospace', ...WRAP_ANYWHERE }}
              >
                {tool.result}
              </Text>
            </ScrollView>
          )}
        </Box>
      )}
    </Box>
  );
}
