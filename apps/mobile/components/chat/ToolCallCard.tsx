import { useState } from 'react';
import { ScrollView } from 'react-native';
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
} from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { ToolCall } from '@/lib/types';

const TOOL_ICONS: Record<string, typeof FileText> = {
  fs_read: FileText,
  fs_write: FilePen,
  fs_edit: FileEdit,
  bash: Terminal,
  grep: Search,
  glob: FolderSearch,
  web_fetch: Globe,
  todo_write: ListTodo,
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
};

/** MCP tools arrive namespaced as `server__tool`; builtins never contain `__`. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) };
}

export function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const mcp = splitMcpTool(tool.tool);
  const ToolIcon = mcp ? Plug : (TOOL_ICONS[tool.tool] ?? HelpCircle);
  // A failed call used to render identically to a successful one, so the only
  // sign anything had gone wrong was the model talking about it afterwards —
  // and a card collapsed by default hid the reason. Tinted on a positive
  // `false` only: all three paths now carry `ok` — the live event, the
  // reconnect snapshot, and history rebuilt from REST — so an absent `ok`
  // means the row predates the field. That is "we were not told", which is
  // still not success. See the same note in `lib/types.ts`.
  const failed = tool.ok === false;
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
          AGENTS.md records for testIDs, which work only because they were
          patched in by hand.) Native is no better — a plain View with a label
          but no `accessible` is not an accessibility element. The Pressable is
          already the focusable element that owns the row, so the failure folds
          into what it announces. */}
      <Pressable
        onPress={() => { setOpen((o) => !o); }}
        accessibilityLabel={failed ? 'Tool call failed' : undefined}
      >
        <HStack className="items-center gap-2 px-3 py-2">
          {/* The failure is carried by colour alone otherwise, which no test
              can select on. */}
          <Box
            testID={failed && tool.callId ? `chat.toolCall.failed.${tool.callId}` : undefined}
            className={`h-5 w-5 items-center justify-center rounded-sm ${tint}`}
          >
            <Icon as={ToolIcon} size="xs" />
          </Box>
          <Text size="sm" className="flex-1 text-card-foreground" numberOfLines={1}>
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
      {open && (
        <Box className="border-t border-border">
          {tool.diff ? (
            <ScrollView testID={tool.callId ? `chat.toolCall.result.${tool.callId}` : undefined} style={{ maxHeight: 200 }}>
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
          ) : (
            <ScrollView testID={tool.callId ? `chat.toolCall.result.${tool.callId}` : undefined} style={{ maxHeight: 200 }}>
              <Text
                className="p-3 text-muted-foreground"
                style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 18 }}
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
